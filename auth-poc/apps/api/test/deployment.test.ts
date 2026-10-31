import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
function render(directory: string) {
  return loadAllYaml(execFileSync("kubectl", ["kustomize", fileURLToPath(new URL(directory, root))], {
    encoding: "utf8",
  }));
}
const windows = render("infra/");
const base = render("k8s/");
function resource(resources: any[], kind: string, name: string) {
  return resources.find((item) => item.kind === kind && item.metadata.name === name);
}

describe("Azure Windows overlay", () => {
  it.each(["api", "reporting-worker"])("schedules %s as an unprivileged Windows container", (name) => {
    const pod = resource(windows, "Deployment", name).spec.template.spec;
    expect(pod.os.name).toBe("windows");
    expect(pod.nodeSelector).toEqual({
      "kubernetes.io/os": "windows",
      "node.kubernetes.io/windows-build": "10.0.26100",
    });
    expect(pod.tolerations).toContainEqual({
      key: "os", operator: "Equal", value: "windows", effect: "NoSchedule",
    });
    expect(pod.containers[0].securityContext).toEqual({
      windowsOptions: { runAsUserName: "ContainerUser" },
    });
    expect(pod.containers[0].imagePullPolicy).toBe("IfNotPresent");
    expect(pod.containers[0].image).toMatch(/:windows$/);
  });

  it("uses Windows volume paths and preserves audience-bound token projection", () => {
    const worker = resource(windows, "Deployment", "reporting-worker").spec.template.spec;
    expect(worker.automountServiceAccountToken).toBe(false);
    expect(worker.serviceAccountName).toBe("reporting-worker");
    expect(worker.containers[0].env).toContainEqual({
      name: "TOKEN_FILE", value: "C:/var/run/api-token/token",
    });
    expect(worker.containers[0].volumeMounts[0]).toEqual({
      name: "api-token", mountPath: "C:/var/run/api-token", readOnly: true,
    });
    expect(worker.volumes[0].projected.sources[0].serviceAccountToken).toEqual({
      path: "token", audience: "urn:identity-poc:api", expirationSeconds: 3600,
    });
    const api = resource(windows, "Deployment", "api").spec.template.spec;
    expect(api.serviceAccountName).toBe("api");
    expect(api.containers[0].env).toContainEqual({ name: "NODE_EXTRA_CA_CERTS", value: "C:/etc/entra/ca.pem" });
    expect(api.containers[0].volumeMounts[0].mountPath).toBe("C:/etc/entra");
  });

  it("keeps the emulator on Linux and both services private", () => {
    expect(resource(windows, "Deployment", "entra-local").spec.template.spec.nodeSelector)
      .toEqual({ "kubernetes.io/os": "linux" });
    for (const name of ["api", "entra-local"]) {
      const service = resource(windows, "Service", name);
      expect(service.spec.type).toBe("ClusterIP");
      expect(service.spec.ports[0]).not.toHaveProperty("nodePort");
    }
  });

  it("reuses the existing least-privilege ServiceAccounts and RBAC unchanged", () => {
    for (const item of base.filter((item: any) => ["ServiceAccount", "ClusterRole", "ClusterRoleBinding"].includes(item.kind))) {
      expect(resource(windows, item.kind, item.metadata.name)).toEqual(item);
    }
  });

  it("leaves the local Kind deployments and NodePorts unchanged", () => {
    for (const name of ["api", "reporting-worker"]) {
      const pod = resource(base, "Deployment", name).spec.template.spec;
      expect(pod).not.toHaveProperty("os");
      expect(pod.containers[0].imagePullPolicy).toBe("Never");
      expect(pod.containers[0].securityContext.runAsNonRoot).toBe(true);
    }
    expect(resource(base, "Service", "api").spec.ports[0].nodePort).toBe(30300);
    expect(resource(base, "Service", "entra-local").spec.ports[0].nodePort).toBe(30443);
  });
});
