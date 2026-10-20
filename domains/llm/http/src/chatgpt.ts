import { Effect } from "effect";
import { planModels, planSource } from "./catalog.ts";
import { refused } from "./http.ts";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
import { callbackOrPaste, loopback, pkce, random } from "./signin.ts";

/**
 * Sign in with ChatGPT: OpenAI's public OAuth client for agents, whose token a ChatGPT plan's account uses at
 * `api.openai.com` directly. Each login registers a client of its own (`dynamic_agent_client`), named for this
 * installation by its device id, and the callback names the client id it was issued, which refreshing needs.
 */
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "Lemma";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
/** A token is refreshed this long before it expires, so no request starts with one about to. */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long exchanging a code for tokens may take. */
const TOKEN_TIMEOUT_MS = 30_000;

interface Authorization {
  readonly code: string;
  readonly clientId: string;
}

/** Whether a callback URL is this login's: what another's says (a stale tab's error) is not this one's to end. */
const ours = (url: URL, state: string) => url.searchParams.get("state") === state;

/** The code and issued client id a callback URL carries, once its state is this login's. */
function authorization(url: URL, state: string): Authorization {
  if (!ours(url, state)) throw new Error("The callback is for another login (its state differs)");
  const error = url.searchParams.get("error");
  if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The callback has no authorization code");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!clientId) throw new Error("The callback did not name the client id OpenAI issued");
  return { code, clientId };
}

/** A redirect URL the person pasted, when the browser could not reach the callback: its state is checked as it is taken. */
function pasted(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste the full URL the browser was sent to");
  }
  if (`${url.origin}${url.pathname}` !== REDIRECT_URI) throw new Error(`The pasted URL must start with ${REDIRECT_URI}`);
  return url;
}

async function token(fetchImpl: typeof fetch, body: URLSearchParams, clientId: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!response.ok) throw await refused(response, "OpenAI's token request failed");
  const data = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; scope?: unknown; expires_in?: unknown };
  const { access_token: access, refresh_token: refresh, scope, expires_in: expiresIn } = data;
  if (typeof access !== "string" || typeof refresh !== "string" || typeof scope !== "string" || typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new Error("OpenAI's token response is missing its tokens");
  }
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(DIRECT_SCOPE)) throw new Error(`OpenAI did not grant ${DIRECT_SCOPE}`);
  return { type: "oauth", access, refresh, expires: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS, clientId, scopes };
}

function login(context: LoginContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const device = yield* Effect.try({ try: () => context.deviceId(), catch: (error) => error });
      if (!UUID.test(device)) return yield* Effect.fail(new Error("Sign in with ChatGPT needs this installation's device id"));
      const { verifier, challenge } = pkce();
      const state = random();
      // The code the callback brings, exchanged for tokens before the browser is told the sign-in went through.
      const accept = (url: URL) => {
        const found = authorization(url, state);
        return token(
          context.fetch,
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: found.clientId,
            code: found.code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE,
          }),
          found.clientId,
          AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        );
      };
      const server = yield* loopback({
        provider: "ChatGPT",
        port: CALLBACK_PORT,
        path: CALLBACK_PATH,
        holders: "by the Codex CLI",
        ours: (url) => ours(url, state),
        accept,
        exchanging: () => Effect.runFork(context.notify({ kind: "progress", message: "Exchanging the authorization code for tokens…" })),
      });
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: DYNAMIC_CLIENT_ID,
        agent_name_hint: AGENT_NAME,
        ext_agent_host_id: `urn:uuid:${device.toLowerCase()}`,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: random(),
      }).toString();
      yield* context.notify({
        kind: "sign-in",
        message: "Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
        links: [{ url: url.toString(), label: "Sign in to OpenAI" }],
      });
      return yield* callbackOrPaste(context, server, "Complete login in your browser, or paste the final redirect URL here:", pasted);
    }),
  );
}

async function refresh(credential: OAuthCredential, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OAuthCredential> {
  const clientId = credential.clientId;
  if (typeof clientId !== "string" || clientId === "") throw new Error("The stored ChatGPT sign-in names no client id");
  return token(
    fetchImpl,
    new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh, resource: RESOURCE }),
    clientId,
    signal,
  );
}

/** A ChatGPT plan's models, as the Codex CLI and app list them, rather than the API's, many of which a plan does not serve. */
const models: NonNullable<OAuthMethod["models"]> = async (known, auth, fetchImpl, signal) => {
  const listed = await planSource(fetchImpl)(auth.key, signal);
  return listed === undefined ? undefined : planModels(known, listed);
};

export const chatgpt: OAuthMethod = { id: "chatgpt", name: "Sign in with ChatGPT", login, refresh, models };
