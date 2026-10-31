import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("deployment target isolation", () => {
  it.each([
    [undefined, ".local", "kind-identity-poc"],
    ["kind", ".local", "kind-identity-poc"],
    ["azure", ".azure", "identity-poc-azure"],
  ])("selects explicit credentials for %s", async (target, directory, context) => {
    vi.stubEnv("IDENTITY_POC_TARGET", target);
    const common = await import("./common.mjs");
    expect(common.local).toBe(resolve(common.root, directory));
    common.kube(["get", "pods"], true);
    expect(execFileSync).toHaveBeenCalledWith("kubectl", [
      "--kubeconfig", resolve(common.local, "kubeconfig"),
      "--context", context, "get", "pods",
    ], expect.objectContaining({ cwd: common.root, stdio: ["pipe", "pipe", "inherit"] }));
  });

  it("rejects unknown targets instead of falling back to Kind", async () => {
    vi.stubEnv("IDENTITY_POC_TARGET", "typo");
    await expect(import("./common.mjs")).rejects.toThrow("IDENTITY_POC_TARGET must be kind or azure");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(["up", "down"])("refuses Kind %s operations when targeting Azure", async (command) => {
    vi.stubEnv("IDENTITY_POC_TARGET", "azure");
    await expect(command === "up" ? import("./up.mjs") : import("./down.mjs")).rejects.toThrow(/Azure/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
