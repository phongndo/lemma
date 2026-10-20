import { refused } from "./http.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
import { deviceFlow, json, postForm } from "./signin.ts";

/**
 * Sign in with SuperGrok or X Premium: xAI's device-code grant for the Grok CLI's client, whose token xAI's API takes as
 * a key. xAI may leave out a refresh token when it does not rotate one, and the one held stays good.
 */
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEFAULT_LIFETIME_S = 3600;
/** A token is refreshed this long before it expires, so no request starts with one about to. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

function credential(body: Record<string, unknown>, previousRefresh?: string): OAuthCredential {
  const access = body.access_token;
  const refresh = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : previousRefresh;
  if (typeof access !== "string" || access === "" || refresh === undefined) throw new Error("xAI's token answer is missing its tokens");
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_LIFETIME_S;
  return { type: "oauth", access, refresh, expires: Date.now() + lifetime * 1000 - EXPIRY_MARGIN_MS };
}

const login = (context: LoginContext) =>
  deviceFlow(context, {
    provider: "xAI",
    authorize: DEVICE_URL,
    fields: { client_id: CLIENT_ID, scope: SCOPE, referrer: "lemma" },
    token: TOKEN_URL,
    poll: (deviceCode) => ({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT_ID, device_code: deviceCode }),
    done: (body) => credential(body),
  });

async function refresh(stored: OAuthCredential, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await postForm(fetchImpl, TOKEN_URL, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: stored.refresh }, signal);
  if (!response.ok) throw await refused(response, "xAI's token refresh failed");
  return credential(await json(response), stored.refresh);
}

export const xai: OAuthMethod = { id: "xai", name: "Sign in with SuperGrok or X Premium", login, refresh };
