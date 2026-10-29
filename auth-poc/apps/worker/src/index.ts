import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const api = process.env.API_URL ?? "http://api.identity-poc.svc.cluster.local:3000";
const tokenFile = process.env.TOKEN_FILE ?? "/var/run/api-token/token";

async function report(): Promise<void> {
  // Projected tokens rotate: never cache the token between reporting cycles.
  const token = (await readFile(tokenFile, "utf8")).trim();
  async function get(path: string): Promise<unknown> {
    const response = await fetch(`${api}${path}`, {
      headers: { authorization: ["Bearer", token].join(" ") },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }
  const identity = await get("/whoami");
  const data = (await get("/data")) as { product: string; quantity: number }[];
  const totalQuantity = data.reduce((sum, item) => sum + item.quantity, 0);
  console.log(JSON.stringify({ identity, report: { products: data.length, totalQuantity } }));
}

while (true) {
  try {
    await report();
  } catch (error) {
    console.error("Reporting cycle failed:", error instanceof Error ? error.message : "unknown error");
  }
  await setTimeout(30000);
}
