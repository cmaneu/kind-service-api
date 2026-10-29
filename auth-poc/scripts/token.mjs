import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { apiApp, entra, entraRequest, tenant } from "./common.mjs";

export async function getUserToken(variant = "valid") {
  if (!["valid", "expired", "invalidSignature", "idToken", "unscoped"].includes(variant)) {
    throw new Error("Use valid, expired, invalidSignature, idToken, or unscoped");
  }
  if (variant !== "valid") {
    const generated = await entra(`/admin/api/apps/${apiApp}/token-generate`, {
      userId: "aaaaaaaa-0000-0000-000000000002",
      tokenType: variant === "idToken" ? "idToken" : "accessToken",
      tokenVariant: ["idToken", "unscoped"].includes(variant) ? "valid" : variant,
    });
    return generated.token;
  }

  // Entra Local 0.1.1's admin preview API emits scp: "". Its supported PKCE
  // flow supplies a real delegated scope without changing the emulator or API.
  const client = "cccccccc-0000-0000-0000-000000000006";
  const redirect = "http://localhost:3000";
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const authorize = `/${tenant}/oauth2/v2.0/authorize`;
  const query = new URLSearchParams({
    client_id: client,
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirect,
    scope: `api://${apiApp}/access_as_user`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  });
  const page = await entraRequest(`${authorize}?${query}`);
  const signedState = /name="__el_state" value="([^"]+)"/.exec(page.text)?.[1];
  if (!signedState) throw new Error("Entra Local sign-in state missing");
  const signedIn = await entraRequest(authorize, new URLSearchParams({
    __el_state: signedState,
    __el_user: "aaaaaaaa-0000-0000-0000-000000000002",
  }).toString(), "application/x-www-form-urlencoded");
  const location = new URL(signedIn.headers.location ?? "");
  const code = location.searchParams.get("code");
  if (location.origin !== redirect || location.searchParams.get("state") !== state || !code) {
    throw new Error("Invalid authorization response");
  }
  // Capture the redirect; no browser, callback server, UI, or MSAL is needed.
  const response = await entraRequest(`/${tenant}/oauth2/v2.0/token`, new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client,
    redirect_uri: redirect,
    code,
    code_verifier: verifier,
  }).toString(), "application/x-www-form-urlencoded");
  const result = JSON.parse(response.text);
  if (typeof result.access_token !== "string") throw new Error("Access token missing");
  return result.access_token;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await getUserToken(process.argv[2] ?? "valid"));
}
