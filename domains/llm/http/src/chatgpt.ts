import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { Effect } from "effect";
import type { LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";

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

const random = () => randomBytes(32).toString("base64url");

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

/** A redirect URL the person pasted, when the browser could not reach the callback. */
function pasted(input: string, state: string): Authorization {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste the full URL the browser was sent to");
  }
  if (`${url.origin}${url.pathname}` !== REDIRECT_URI) throw new Error(`The pasted URL must start with ${REDIRECT_URI}`);
  return authorization(url, state);
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escaped = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** The page the browser is shown; what it says comes from the callback's URL, which anyone can send it, so is escaped. */
const page = (title: string, detail = "") =>
  `<!doctype html><meta charset="utf-8"><title>Lemma</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem"><h1>${escaped(title)}</h1><p>${escaped(detail)}</p></body>`;

/** The local server the browser is sent back to, and the authorization it brings, once one with this login's state does. */
const callback = (state: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: Server; readonly result: Promise<Authorization> }, Error>((resume) => {
      let settle!: { resolve: (value: Authorization) => void; reject: (error: Error) => void };
      const result = new Promise<Authorization>((resolve, reject) => (settle = { resolve, reject }));
      // Kept from becoming an unhandled rejection when the paste wins and the server closes unanswered.
      result.catch(() => undefined);
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "", REDIRECT_URI);
        const send = (status: number, body: string) => response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
        if (url.pathname !== CALLBACK_PATH) return send(404, page("Not found"));
        try {
          const found = authorization(url, state);
          send(200, page("Signed in to ChatGPT", "You can close this window."));
          settle.resolve(found);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send(400, page("ChatGPT was not connected", message));
          if (ours(url, state) && url.searchParams.has("error")) settle.reject(new Error(message));
        }
      });
      server.once("error", (error: NodeJS.ErrnoException) =>
        resume(
          Effect.fail(
            error.code === "EADDRINUSE"
              ? new Error(`Port ${CALLBACK_PORT} is in use, probably by an unfinished login elsewhere or by the Codex CLI. Cancel that login and try again.`)
              : error,
          ),
        ),
      );
      server.listen(CALLBACK_PORT, "127.0.0.1", () => resume(Effect.succeed({ server, result })));
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.close();
        // A connection the browser opened ahead of time could otherwise take a later login's callback.
        server.closeAllConnections();
      }),
  );

async function token(fetchImpl: typeof fetch, body: URLSearchParams, clientId: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`OpenAI's token request failed (${response.status}): ${(await response.text().catch(() => "")) || response.statusText}`);
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
      const verifier = random();
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = random();
      const server = yield* callback(state);
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
      // The browser's callback, or the URL pasted by hand: whichever comes first, the other withdrawn.
      const found = yield* Effect.raceFirst(
        Effect.promise(() =>
          server.result.then(
            (value) => ({ value }),
            (error: Error) => ({ error }),
          ),
        ).pipe(Effect.flatMap((settled) => ("error" in settled ? Effect.fail(settled.error) : Effect.succeed(settled.value)))),
        context
          .ask("Complete login in your browser, or paste the final redirect URL here:", { placeholder: REDIRECT_URI, kind: "sign-in-code" })
          .pipe(Effect.flatMap((input) => Effect.try({ try: () => pasted(input, state), catch: (error) => error }))),
      );
      yield* context.notify({ kind: "progress", message: "Exchanging the authorization code for tokens…" });
      return yield* Effect.tryPromise({
        try: (signal) =>
          token(
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
            signal,
          ),
        catch: (error) => error,
      });
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

export const chatgpt: OAuthMethod = { name: "Sign in with ChatGPT", login, refresh };
