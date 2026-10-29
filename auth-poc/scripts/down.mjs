import { rmSync } from "node:fs";
import { cluster, local, run } from "./common.mjs";

run("kind", ["delete", "cluster", "--name", cluster]);
rmSync(local, { recursive: true, force: true });
console.log("Removed the dedicated identity-poc cluster and local certificate/kubeconfig.");
