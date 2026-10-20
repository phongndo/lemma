import { Effect } from "effect";
import { refused } from "./http.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
import { deviceFlow, json, trustedLink } from "./signin.ts";

/**
 * Sign in with Meta: Meta's device-code grant for the Muse Code CLI's client gives an identity token, which its API does
 * not take; it mints a Model API key, good for about a day. The identity token is kept as the refresh token, and a
 * refresh mints a key again. It cannot itself be renewed, so once Meta refuses it (401, 403), only signing in again helps.
 */
const CLIENT_ID = "1031625952748946";
const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MINT_URL = "https://api.meta.ai/muse-code/key";
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A key is minted again this long before it lapses. */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;

/** A Model API key minted for an identity token. */
async function mint(fetchImpl: typeof fetch, identity: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetchImpl(MINT_URL, {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${identity}`, "content-type": "application/json", "x-api-version": "1.0.0" },
    body: "{}",
    signal,
  });
  if (!response.ok) throw await refused(response, "Meta's API key request failed");
  const body = await json(response);
  if (typeof body.api_key !== "string" || body.api_key === "") {
    const setup = trustedLink(body.action_url);
    throw new Error(`Meta issued no API key${setup === undefined ? "" : `: finish setting up at ${setup}`}`);
  }
  return { type: "oauth", access: body.api_key, refresh: identity, expires: Date.now() + KEY_LIFETIME_MS - EXPIRY_MARGIN_MS };
}

function login(context: LoginContext) {
  return Effect.gen(function* () {
    const identity = yield* deviceFlow(context, {
      provider: "Meta",
      authorize: DEVICE_URL,
      fields: { client_id: CLIENT_ID },
      token: TOKEN_URL,
      poll: (deviceCode) => ({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CLIENT_ID }),
      done: (body) => body.access_token as string,
    });
    yield* context.notify({ kind: "progress", message: "Turning on Meta Model API access…" });
    return yield* Effect.tryPromise({
      try: (signal) => mint(context.fetch, identity, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])),
      catch: (error) => error,
    });
  });
}

export const meta: OAuthMethod = {
  id: "meta",
  name: "Sign in with Meta",
  login,
  refresh: (stored, fetchImpl, signal) => mint(fetchImpl, stored.refresh, signal),
};
