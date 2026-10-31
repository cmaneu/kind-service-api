import assert from "node:assert/strict";
import { audience, cluster, entra, issuer, kube, target, tenant } from "./common.mjs";
import { getUserToken } from "./token.mjs";

const api = "http://127.0.0.1:3000";
async function check(label, token, status, type) {
  for (const endpoint of ["/whoami", "/data"]) {
    const response = await fetch(`${api}${endpoint}`, {
      headers: token ? { authorization: ["Bearer", token].join(" ") } : {},
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, status, `${label} ${endpoint}`);
    if (endpoint === "/whoami" && type) {
      const identity = await response.json();
      assert.equal(identity.type, type);
      if (type === "service") {
        assert.equal(identity.namespace, cluster);
        assert.equal(identity.serviceAccount, "reporting-worker");
      }
    }
    if (endpoint === "/data" && status === 200) {
      const data = await response.json();
      assert.equal(data.reduce((sum, item) => sum + item.quantity, 0), 25);
    }
  }
  console.log(`PASS ${label}: ${status}`);
}

if (target === "azure") {
  for (const app of ["api", "reporting-worker"]) {
    const pods = JSON.parse(kube(["get", "pods", "-n", cluster, "-l", `app=${app}`, "-o", "json"], true));
    assert.ok(pods.items.length > 0, `${app} must have a running Pod`);
    for (const pod of pods.items) {
      const node = JSON.parse(kube(["get", "node", pod.spec.nodeName, "-o", "json"], true));
      assert.equal(node.status.nodeInfo.operatingSystem, "windows", `${app} must run on Windows`);
    }
    assert.equal(kube(["exec", "-n", cluster, `deployment/${app}`, "--",
      "node", "-p", "process.platform"], true).trim(), "win32");
  }
  console.log("PASS API and worker run on Windows");
}
const discovery = await entra(`/${tenant}/v2.0/.well-known/openid-configuration`);
assert.equal(discovery.issuer, issuer);
assert.equal((await fetch(`${api}/health`)).status, 200);
await check("no token", undefined, 401);
await check("Entra delegated user", await getUserToken(), 200, "user");
// Read the actual projected token, not a locally fabricated workload credential.
const workerToken = kube(["exec", "-n", cluster, "deployment/reporting-worker", "--",
  "node", "-e", 'process.stdout.write(require("node:fs").readFileSync(process.env.TOKEN_FILE || "/var/run/api-token/token","utf8"))'], true).trim();
await check("projected worker token", workerToken, 200, "service");
function serviceToken(account, requestedAudience) {
  return kube(["create", "token", account, "-n", cluster,
    `--audience=${requestedAudience}`, "--duration=10m"], true).trim();
}
await check("wrong workload audience", serviceToken("reporting-worker", "wrong-audience"), 401);
await check("unauthorized ServiceAccount", serviceToken("api", audience), 403);
for (const variant of ["expired", "invalidSignature", "idToken", "unscoped"]) {
  await check(`Entra ${variant}`, await getUserToken(variant), 401);
}
assert.throws(() => kube(["auth", "can-i", "create", "tokenreviews",
  `--as=system:serviceaccount:${cluster}:reporting-worker`], true),
  (error) => error.status === 1 && error.stdout.trim() === "no");
let logged = false;
for (let attempt = 0; attempt < 40; attempt++) {
  const logs = kube(["logs", "-n", cluster, "deployment/reporting-worker", "--tail=20"], true);
  if (logs.split(/\r?\n/).some((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.identity?.type === "service" && entry.report?.totalQuantity === 25;
    } catch { return false; }
  })) { logged = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.ok(logged, "Worker must log its authenticated identity and report");
console.log("PASS worker report; worker has no TokenReview permission");
