import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { LlmError } from "@lemma/contracts";
import type { LoginUi, OAuthCredential, OAuthMethod } from "./auth.ts";
import { deviceId } from "./device.ts";
import { USER_AGENT } from "./identity.ts";

/*
 * Sign in with ChatGPT, as OpenAI offers it to open-source apps
 * (https://developers.openai.com/siwc/token-sharing-open-source/sign-in): a public client with PKCE, registered under
 * the app's name at the first sign-in, whose token calls the Responses API on the user's ChatGPT plan. Endpoints are
 * those of https://auth.openai.com/.well-known/openid-configuration.
 */
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const RESOURCE = "https://api.openai.com/v1";
/** Lets the token spend the user's ChatGPT plan; without it the sign-in cannot make requests. */
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const CALLBACK_PATH = "/auth/callback";
/** Asks a first sign-in to register a client for this app; the callback names the client issued. */
const REGISTER = "dynamic_agent_client";
const APP_NAME = "Lemma";
const CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The client OpenAI issued this installation, kept past logout so signing in again does not register another. */
interface Registration {
  readonly clientId: string;
  /** The account it was registered for, once known. */
  readonly subject?: string;
  readonly email?: string;
  /** The last sign-in did not allow plan use: the next asks for consent again, as OpenAI's recovery guide says. */
  readonly reconsent?: boolean;
}

const registrationPath = (home: string) => join(home, "chatgpt.json");

function readRegistration(home: string): Registration | undefined {
  try {
    const value = JSON.parse(readFileSync(registrationPath(home), "utf8")) as Partial<Registration>;
    if (typeof value.clientId !== "string" || !CLIENT_ID.test(value.clientId)) return undefined;
    return {
      clientId: value.clientId,
      ...(typeof value.subject === "string" ? { subject: value.subject } : {}),
      ...(typeof value.email === "string" ? { email: value.email } : {}),
      ...(value.reconsent === true ? { reconsent: true } : {}),
    };
  } catch {
    return undefined;
  }
}

const writeRegistration = (home: string, registration: Registration) =>
  Effect.try({
    try: () => writeFileSync(registrationPath(home), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 }),
    catch: (cause) => loginFailed(`could not save the registration in ${home}`, cause),
  });

const forgetRegistration = (home: string) =>
  Effect.try({
    try: () => rmSync(registrationPath(home), { force: true }),
    catch: (cause) => loginFailed(`could not remove the registration in ${home}`, cause),
  });

const random = () => randomBytes(32).toString("base64url");

const loginFailed = (message: string, cause?: unknown) =>
  new LlmError({ reason: "LoginFailed", message: `ChatGPT sign-in failed: ${message}`, ...(cause === undefined ? {} : { cause }) });

/** A form POST to OpenAI's auth server, answered with JSON. Not tied to the caller's signal: a used refresh token must not be lost. */
const post = (fetchImpl: typeof fetch, url: string, form: Record<string, string>) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? {} : JSON.parse(text);
      } catch {
        body = {};
      }
      return { status: response.status, body: (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown> };
    },
    catch: (cause) => loginFailed(`could not reach ${new URL(url).host}: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
  });

const oauthError = (status: number, body: Record<string, unknown>) => {
  const code = typeof body["error"] === "string" ? body["error"] : undefined;
  const description = typeof body["error_description"] === "string" ? body["error_description"] : undefined;
  return loginFailed(`${description ?? code ?? "unexpected response"} (HTTP ${status}${code === undefined || description === undefined ? "" : `, ${code}`})`);
};

interface Tokens {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly scopes: readonly string[];
  readonly idToken?: string;
  readonly earliestRefreshAt?: number;
}

/** Whether a token response grants plan use; a refresh may leave out `scope` when the grant is unchanged. */
const grantsPlan = (body: Record<string, unknown>) => typeof body["scope"] !== "string" || body["scope"].split(/\s+/).includes(PLAN_SCOPE);

/** The client OpenAI no longer knows: removed from the user's ChatGPT settings, say. */
const unknownClient = (body: Record<string, unknown>) => body["error"] === "invalid_client" || body["error"] === "unauthorized_client";

/** A token response, checked. A refresh may leave out `scope` when the grant is unchanged. */
function tokens(body: Record<string, unknown>, previousScopes?: readonly string[]): Tokens {
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn, token_type: tokenType, id_token: idToken } = body;
  if (typeof access !== "string" || access === "" || typeof refresh !== "string" || refresh === "") throw loginFailed("the token response is incomplete");
  if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") throw loginFailed(`unexpected token type ${tokenType}`);
  if (typeof expiresIn !== "number" || !(expiresIn > 0)) throw loginFailed("the token response has no expiry");
  const scopes = typeof body["scope"] === "string" ? body["scope"].split(/\s+/).filter(Boolean) : previousScopes;
  if (scopes === undefined) throw loginFailed("ChatGPT did not say what it granted");
  if (!scopes.includes(PLAN_SCOPE)) {
    throw loginFailed("ChatGPT did not allow Lemma to use your plan. Sign in again to be asked again, or check that your plan offers it.");
  }
  const earliest = body["earliest_refresh_at"];
  const earliestRefreshAt = typeof earliest === "number" ? earliest * 1000 : typeof earliest === "string" ? Date.parse(earliest) : Number.NaN;
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    scopes,
    ...(typeof idToken === "string" && idToken !== "" ? { idToken } : {}),
    ...(Number.isFinite(earliestRefreshAt) ? { earliestRefreshAt } : {}),
  };
}

/**
 * The account an ID token names, after checking it was issued by OpenAI for this client (and this sign-in, by its
 * nonce) and has not expired. Its signature is not checked: it comes straight from the token endpoint over TLS, which
 * OpenID Connect accepts in place of one (Core 1.0, section 3.1.3.7).
 */
function identity(idToken: string, clientId: string, nonce?: string): { readonly subject: string; readonly email?: string } {
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw loginFailed("the ID token cannot be read");
  }
  const { iss, aud, azp, exp, sub, email } = claims;
  const audiences = Array.isArray(aud) ? aud : [aud];
  const valid =
    iss === ISSUER &&
    audiences.includes(clientId) &&
    (azp === undefined ? audiences.length === 1 : azp === clientId) &&
    typeof exp === "number" &&
    exp * 1000 > Date.now() - 60_000 &&
    typeof sub === "string" &&
    sub !== "" &&
    (nonce === undefined || claims["nonce"] === nonce);
  if (!valid) throw loginFailed("the ID token was not issued for this sign-in");
  return { subject: sub, ...(typeof email === "string" ? { email } : {}) };
}

/** The code and client a callback (or the address the user pasted) carries, once it matches this sign-in. */
function authorization(params: URLSearchParams, state: string, registered: string | undefined) {
  const returned = params.get("state") ?? "";
  if (returned.length !== state.length || !timingSafeEqual(Buffer.from(returned), Buffer.from(state))) throw loginFailed("the address is from another sign-in");
  const error = params.get("error");
  if (error !== null) throw loginFailed(error === "access_denied" ? "access was not allowed" : (params.get("error_description") ?? error));
  const code = params.get("code");
  const issued = params.get("client_id");
  const clientId = issued ?? registered;
  if (
    !code ||
    clientId === undefined ||
    clientId === REGISTER ||
    !CLIENT_ID.test(clientId) ||
    (registered !== undefined && issued !== null && issued !== registered)
  ) {
    throw loginFailed("ChatGPT did not finish registering Lemma. Try again.");
  }
  return { code, clientId };
}

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;max-width:32rem;margin:18vh auto;padding:24px}</style><h1>${title}</h1><p>${text}</p></html>`;

/** Listens on a free loopback port for the browser's return; its result is the first callback that matches `state`. */
const callbackServer = (state: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const result = yield* Deferred.make<URLSearchParams>();
      const server = createServer((request, response) => {
        const port = (server.address() as AddressInfo).port;
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        // Any local process can send anything here: a target that is not an address is turned away, not thrown.
        const url = URL.parse(request.url ?? "/", `http://127.0.0.1:${port}`);
        // Only the browser coming back to this address; another page cannot reach it under another name.
        if (url === null || request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH) {
          response.writeHead(404).end();
          return;
        }
        // Left for a later request: an old tab, or another sign-in's return, must not end this one.
        if (url.searchParams.get("state") !== state) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Not this sign-in", "Return to the tab Lemma opened."));
          return;
        }
        const ok = !url.searchParams.has("error");
        response
          .writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
          .end(ok ? page("Signed in", "You can close this tab and return to Lemma.") : page("Not signed in", "Return to Lemma to try again."));
        Deferred.unsafeDone(result, Effect.succeed(url.searchParams));
      });
      yield* Effect.async<void, LlmError>((resume) => {
        server.once("error", (cause) => resume(Effect.fail(loginFailed(`could not listen for the browser: ${cause.message}`, cause))));
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      });
      return { server, port: (server.address() as AddressInfo).port, result: Deferred.await(result) };
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.close();
        // Browsers keep spare connections open, which would hold the server.
        server.closeAllConnections();
      }),
  );

/** Sign in with ChatGPT for `openai`. `home` keeps the installation's ID and its registration. */
export function chatgptSignIn(options: { readonly home: string; readonly fetch?: typeof fetch }): OAuthMethod {
  const { home } = options;
  const fetchImpl = options.fetch ?? fetch;

  const login = (ui: LoginUi) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registration = readRegistration(home);
        const host = yield* Effect.try({ try: () => deviceId(home), catch: (cause) => loginFailed(`could not read this installation's ID in ${home}`, cause) });
        const state = random();
        const nonce = random();
        const verifier = random();
        const listener = yield* callbackServer(state);
        const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
        const url = new URL(AUTHORIZE_URL);
        url.search = new URLSearchParams({
          client_id: registration?.clientId ?? REGISTER,
          response_type: "code",
          redirect_uri: redirectUri,
          scope: SCOPE,
          resource: RESOURCE,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          ext_agent_host_id: `urn:uuid:${host.toLowerCase()}`,
          // The name shows in the user's ChatGPT settings; a registered client already has one.
          ...(registration === undefined ? { agent_name_hint: APP_NAME } : {}),
          ...(registration?.email === undefined ? {} : { login_hint: registration.email }),
          ...(registration?.reconsent === true ? { prompt: "consent" } : {}),
        }).toString();
        yield* ui.notify({
          level: "info",
          source: "llm",
          message: "Sign in with ChatGPT in your browser. If the browser cannot reach this computer, paste the address it ends on.",
          links: [{ url: url.toString(), label: "Sign in with ChatGPT" }],
        });
        // The browser's return, or the address the user pastes (a host on another machine); the other is withdrawn.
        // An address that is not this sign-in's asks again; a prompt no client can answer leaves the browser to finish.
        const paste = (message: string): Effect.Effect<URLSearchParams, LlmError> =>
          ui.ask(message, { placeholder: redirectUri }).pipe(
            Effect.catchAll((error) => (error.reason === "Cancelled" ? Effect.fail(error) : Effect.never)),
            Effect.flatMap((input) => {
              const back = URL.parse(input.trim());
              return back !== null && back.origin === new URL(redirectUri).origin && back.pathname === CALLBACK_PATH
                ? Effect.succeed(back.searchParams)
                : paste(`That is not the address this sign-in ends on. Paste the one that starts with ${redirectUri}`);
            }),
          );
        const pasted = paste("Sign in with ChatGPT in your browser, or paste the address it ends on");
        const params = yield* Effect.raceFirst(listener.result, pasted);
        const { code, clientId } = yield* Effect.try({ try: () => authorization(params, state, registration?.clientId), catch: (error) => error as LlmError });
        // Kept before the code is used: if the exchange fails, signing in again reuses the client rather than adding one.
        if (registration === undefined) yield* writeRegistration(home, { clientId });
        const response = yield* post(fetchImpl, TOKEN_URL, {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE,
        });
        if (response.status !== 200) {
          // The next sign-in registers anew.
          if (unknownClient(response.body)) yield* forgetRegistration(home);
          return yield* oauthError(response.status, response.body);
        }
        if (!grantsPlan(response.body)) yield* writeRegistration(home, { ...registration, clientId, reconsent: true });
        const fresh = yield* Effect.try({ try: () => tokens(response.body), catch: (error) => error as LlmError });
        if (fresh.idToken === undefined) return yield* loginFailed("ChatGPT did not say which account signed in");
        const who = yield* Effect.try({ try: () => identity(fresh.idToken!, clientId, nonce), catch: (error) => error as LlmError });
        if (registration?.subject !== undefined && who.subject !== registration.subject) {
          // A client belongs to one account: these tokens are not kept, and the next sign-in registers anew.
          yield* revoke(clientId, fresh.refresh).pipe(Effect.ignore);
          yield* forgetRegistration(home);
          const account = who.email ?? "another account";
          return yield* loginFailed(
            `you chose ${account}, but Lemma is registered here for ${registration.email ?? "a different account"}. Sign in again to register Lemma for ${account}.`,
          );
        }
        yield* writeRegistration(home, { clientId, ...who });
        return credential(fresh, clientId, who);
      }),
    );

  const revoke = (clientId: string, refreshToken: string) =>
    Effect.flatMap(post(fetchImpl, REVOKE_URL, { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }), (response) =>
      response.status === 200 ? Effect.void : oauthError(response.status, response.body),
    );

  return {
    name: "Sign in with ChatGPT",
    login,
    refresh: (stored) =>
      Effect.gen(function* () {
        const clientId = stored["clientId"];
        if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return yield* loginFailed("this sign-in has no client to renew it with. Sign in again.");
        const response = yield* post(fetchImpl, TOKEN_URL, {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: stored.refresh,
          resource: RESOURCE,
        });
        if (response.status !== 200) {
          if (unknownClient(response.body)) yield* forgetRegistration(home);
          const error = oauthError(response.status, response.body);
          // Refused (the grant or the client is no longer good): sign in again. Otherwise the next request tries again.
          return yield* response.status === 400 || response.status === 401 ? renewalFailed(error) : error;
        }
        const scopes = stored["scopes"];
        const fresh = yield* Effect.try({
          try: () => tokens(response.body, Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : undefined),
          catch: (error) => error as LlmError,
        });
        const subject = typeof stored["subject"] === "string" ? stored["subject"] : undefined;
        const email = typeof stored["email"] === "string" ? stored["email"] : undefined;
        let who = subject === undefined ? undefined : { subject, ...(email === undefined ? {} : { email }) };
        if (fresh.idToken !== undefined) {
          const named = yield* Effect.try({ try: () => identity(fresh.idToken!, clientId), catch: (error) => error as LlmError });
          if (subject !== undefined && named.subject !== subject) return yield* loginFailed("the renewed sign-in is for another account. Sign in again.");
          who = named;
        }
        return credential(fresh, clientId, who);
      }),
    revoke: (stored) => {
      const clientId = stored["clientId"];
      return typeof clientId === "string" ? revoke(clientId, stored.refresh) : Effect.void;
    },
  };
}

/** A refresh the auth server refused means the user must sign in again; the message says so. */
const renewalFailed = (error: LlmError) =>
  new LlmError({ reason: "NotConfigured", message: `${error.message}. Run /login openai to sign in again.`, cause: error });

function credential(fresh: Tokens, clientId: string, who: { readonly subject: string; readonly email?: string } | undefined): OAuthCredential {
  return {
    type: "oauth",
    access: fresh.access,
    refresh: fresh.refresh,
    expires: fresh.expires,
    clientId,
    scopes: [...fresh.scopes],
    ...who,
    ...(fresh.earliestRefreshAt === undefined ? {} : { earliestRefreshAt: fresh.earliestRefreshAt }),
  };
}
