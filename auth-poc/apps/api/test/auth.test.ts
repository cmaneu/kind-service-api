import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthenticate, workloadAudience, type ReviewResult } from "../src/auth.js";

const issuer = "https://issuer.example/tenant/v2.0";
const audience = "local-api";
const keys = await generateKeyPair("RS256");
const review = vi.fn<(token: string) => Promise<ReviewResult | undefined>>();
const servers: Server[] = [];
let base: string;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function userToken(overrides: Record<string, unknown> = {}, badKey = false) {
  const key = badKey ? (await generateKeyPair("RS256")).privateKey : keys.privateKey;
  return new SignJWT({
    sub: "alice",
    name: "Alice",
    scp: "access_as_user",
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(key);
}

const workloadToken = await new SignJWT({})
  .setIssuer("https://kubernetes.default.svc.cluster.local")
  .setProtectedHeader({ alg: "RS256" })
  .sign(keys.privateKey);

async function request(token?: string, path = "/whoami") {
  return fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: ["Bearer", token].join(" ") },
  });
}

beforeAll(async () => {
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
  const jwks = await listen(createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [publicKey] }));
  }));
  const app = express();
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  const authenticate = createAuthenticate({
    issuer,
    audience,
    jwks: createRemoteJWKSet(new URL(jwks)),
    review,
  });
  app.get("/whoami", authenticate, (req, res) => res.json(req.principal));
  app.get("/data", authenticate, (_req, res) => res.json([]));
  base = await listen(createServer(app));
});

beforeEach(() => { review.mockReset(); });
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("shared authentication middleware", () => {
  it("leaves health public and protects both endpoints", async () => {
    expect((await request(undefined, "/health")).status).toBe(200);
    for (const path of ["/whoami", "/data"]) {
      expect((await request(undefined, path)).status).toBe(401);
      expect((await request("malformed", path)).status).toBe(401);
    }
    expect(review).not.toHaveBeenCalled();
  });

  it("verifies a signed delegated user token using JWKS", async () => {
    const token = await userToken();
    const response = await request(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "user", provider: "entra", subject: "alice", name: "Alice",
    });
    expect((await request(token, "/data")).status).toBe(200);
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", { exp: 1 }],
    ["missing expiration", { exp: undefined }],
    ["wrong audience", { aud: "another-api" }],
    ["ID token without delegated scope", { scp: undefined }],
    ["wrong scope", { scp: "read_something_else" }],
    ["missing subject", { sub: undefined }],
    ["wrong issuer", { iss: `${issuer}/wrong` }],
  ])("rejects %s", async (_label, claims) => {
    expect((await request(await userToken(claims))).status).toBe(401);
  });

  it("rejects invalid signatures without falling back to TokenReview", async () => {
    expect((await request(await userToken({}, true))).status).toBe(401);
    expect(review).not.toHaveBeenCalled();
  });

  it("normalizes the authorized ServiceAccount on both endpoints", async () => {
    review.mockResolvedValue({
      authenticated: true,
      audiences: [workloadAudience],
      user: { username: "system:serviceaccount:identity-poc:reporting-worker" },
    });
    const response = await request(workloadToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "service", provider: "kubernetes",
      serviceAccount: "reporting-worker", namespace: "identity-poc",
    });
    expect((await request(workloadToken, "/data")).status).toBe(200);
    expect(review).toHaveBeenCalledWith(workloadToken);
  });

  it.each([
    undefined,
    { authenticated: false, audiences: [workloadAudience] },
    { authenticated: true },
    { authenticated: true, audiences: ["wrong"] },
  ])("rejects invalid TokenReview results: %j", async (result) => {
    review.mockResolvedValue(result);
    expect((await request(workloadToken)).status).toBe(401);
  });

  it("returns 403 only for authenticated, wrong ServiceAccounts", async () => {
    review.mockResolvedValue({
      authenticated: true, audiences: [workloadAudience],
      user: { username: "system:serviceaccount:identity-poc:api" },
    });
    expect((await request(workloadToken)).status).toBe(403);
  });

  it("fails closed when TokenReview is unavailable", async () => {
    review.mockRejectedValue(new Error("unavailable"));
    expect((await request(workloadToken)).status).toBe(401);
  });
});
