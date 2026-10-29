import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const local = resolve(root, ".local");
export const cluster = "identity-poc";
export const tenant = "11111111-1111-1111-1111-111111111111";
export const apiApp = "cccccccc-0000-0000-0000-000000000007";
export const audience = "urn:identity-poc:api";
export const issuer = `https://localhost:8443/${tenant}/v2.0`;
export const entraImage = "ghcr.io/cmaneu/entra-local:latest";

export function run(command, args, capture = false) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: capture ? ["pipe", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    timeout: 600000,
  });
}

export function kube(args, capture = false) {
  return run("kubectl", [
    "--kubeconfig", resolve(local, "kubeconfig"),
    "--context", `kind-${cluster}`, ...args,
  ], capture);
}

export function entraRequest(path, data, contentType = "application/json") {
  return new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, "https://localhost:8443"), {
      method: data === undefined ? "GET" : "POST",
      ca: readFileSync(resolve(local, "entra-ca.pem")),
      headers: data ? { "content-type": contentType } : {},
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 400) {
          reject(new Error(`Entra Local ${path}: HTTP ${res.statusCode}`));
          return;
        }
        resolveResponse({ text, headers: res.headers, status: res.statusCode });
      });
      res.on("error", reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error("Entra Local request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

export async function entra(path, body) {
  const response = await entraRequest(path, body === undefined ? undefined : JSON.stringify(body));
  return JSON.parse(response.text);
}

export async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* Wait for the mapped service port to become reachable. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Not ready: ${url}`);
}
