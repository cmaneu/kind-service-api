import express from "express";
import { rateLimit } from "express-rate-limit";
import { AuthenticationV1Api, KubeConfig, Observable } from "@kubernetes/client-node";
import { createRemoteJWKSet } from "jose";
import { createAuthenticate, workloadAudience } from "./auth.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const kubeConfig = new KubeConfig();
kubeConfig.loadFromCluster();
const kubernetes = kubeConfig.makeApiClient(AuthenticationV1Api);
const authenticate = createAuthenticate({
  issuer: required("ENTRA_ISSUER"),
  audience: required("ENTRA_AUDIENCE"),
  jwks: createRemoteJWKSet(new URL(required("ENTRA_JWKS_URL"))),
  review: async (token) => {
    const result = await kubernetes.createTokenReview(
      {
        body: {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: { token, audiences: [workloadAudience] },
        },
      },
      {
        middleware: [{
          pre: (context) => {
            context.setSignal(AbortSignal.timeout(5000));
            return new Observable(Promise.resolve(context));
          },
          post: (context) => new Observable(Promise.resolve(context)),
        }],
      },
    );
    return result.status;
  },
});

const app = express();
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
app.get("/whoami", authenticate, (req, res) => res.json(req.principal));
app.get("/data", authenticate, (_req, res) =>
  res.json([
    { product: "apples", quantity: 12 },
    { product: "oranges", quantity: 8 },
    { product: "pears", quantity: 5 },
  ]),
);
app.listen(3000, "0.0.0.0", () => console.log("API listening on :3000"));
