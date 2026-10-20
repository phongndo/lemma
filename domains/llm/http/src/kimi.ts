import { refused } from "./http.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
import { deviceFlow, json, postForm } from "./signin.ts";

/**
 * Sign in with Kimi Code: Kimi's device-code grant for its CLI's client, whose token its coding plan's API takes as a
 * bearer token.
 */
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const HOST = "https://auth.kimi.com";
/** A token is refreshed this long before it expires, so no request starts with one about to. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

function credential(body: Record<string, unknown>): OAuthCredential {
  const { access_token: access, refresh_token: refresh, expires_in: lifetime } = body;
  if (typeof access !== "string" || access === "" || typeof refresh !== "string" || refresh === "" || typeof lifetime !== "number" || lifetime <= 0) {
    throw new Error("Kimi's token answer is missing its tokens");
  }
  return { type: "oauth", access, refresh, expires: Date.now() + lifetime * 1000 - EXPIRY_MARGIN_MS };
}

const login = (context: LoginContext) =>
  deviceFlow(context, {
    provider: "Kimi Code",
    authorize: `${HOST}/api/oauth/device_authorization`,
    fields: { client_id: CLIENT_ID },
    token: `${HOST}/api/oauth/token`,
    poll: (deviceCode) => ({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    done: credential,
  });

async function refresh(stored: OAuthCredential, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await postForm(
    fetchImpl,
    `${HOST}/api/oauth/token`,
    { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: stored.refresh },
    signal,
  );
  if (!response.ok) throw await refused(response, "Kimi's token refresh failed");
  return credential(await json(response));
}

export const kimi: OAuthMethod = { id: "kimi", name: "Sign in with Kimi Code", login, refresh };
