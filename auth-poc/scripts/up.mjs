import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { X509Certificate } from "node:crypto";
import { cluster, entraImage, kube, local, run, target, waitFor } from "./common.mjs";

if (target !== "kind") throw new Error("Use scripts/azure-up.ps1 for Azure");
mkdirSync(local, { recursive: true });
run("docker", ["info"], true);
const clusters = run("kind", ["get", "clusters"], true).trim().split(/\r?\n/);
if (!clusters.includes(cluster)) {
  const config = resolve(local, "kind.yaml");
  writeFileSync(config, `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30300
        hostPort: 3000
        listenAddress: "127.0.0.1"
      - containerPort: 30443
        hostPort: 8443
        listenAddress: "127.0.0.1"
`);
  run("kind", ["create", "cluster", "--name", cluster, "--config", config,
    "--kubeconfig", resolve(local, "kubeconfig"), "--wait", "180s"]);
}
writeFileSync(resolve(local, "kubeconfig"), run("kind", ["get", "kubeconfig", "--name", cluster], true), { mode: 0o600 });

run("docker", ["pull", entraImage]);
run("kind", ["load", "docker-image", "--name", cluster, entraImage]);
for (const app of ["api", "worker"]) {
  run("docker", ["build", "-f", `Dockerfile.${app}`, "-t", `identity-poc-${app}:local`, "."]);
  run("kind", ["load", "docker-image", "--name", cluster, `identity-poc-${app}:local`]);
}
kube(["apply", "-f", "k8s/namespace.yaml"]);
kube(["apply", "-f", "k8s/entra.yaml"]);
kube(["rollout", "status", "-n", cluster, "deployment/entra-local", "--timeout=180s"]);
const certificate = kube(["exec", "-n", cluster, "deployment/entra-local", "--",
  "node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/app/data/tls/cert.pem","utf8"))'], true);
new X509Certificate(certificate);
writeFileSync(resolve(local, "entra-ca.pem"), certificate);
const configMap = JSON.parse(kube(["create", "configmap", "entra-ca", "-n", cluster,
  `--from-file=ca.pem=${resolve(local, "entra-ca.pem")}`, "--dry-run=client", "-o", "json"], true));
writeFileSync(resolve(local, "ca-configmap.json"), JSON.stringify(configMap));
kube(["apply", "-f", resolve(local, "ca-configmap.json")]);
kube(["apply", "-f", "k8s/rbac.yaml"]);
kube(["apply", "-f", "k8s/apps.yaml"]);
// Restart reused deployments to pick up rebuilt local images and refreshed trust.
kube(["rollout", "restart", "-n", cluster, "deployment/api", "deployment/reporting-worker"]);
for (const deployment of ["api", "reporting-worker"]) {
  kube(["rollout", "status", "-n", cluster, `deployment/${deployment}`, "--timeout=180s"]);
}
await waitFor("http://127.0.0.1:3000/health");
console.log("Ready: API http://localhost:3000; Entra Local https://localhost:8443");
