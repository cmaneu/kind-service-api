import { rmSync } from "node:fs";
import { cluster, local, run, target } from "./common.mjs";

if (target !== "kind") throw new Error("Delete the dedicated Azure resource group to clean up Azure");
run("kind", ["delete", "cluster", "--name", cluster]);
rmSync(local, { recursive: true, force: true });
console.log("Removed the dedicated identity-poc cluster and local certificate/kubeconfig.");
