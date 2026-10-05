import { Effect } from "effect";
import { LlmError } from "@lemma/contracts";
import type { Credential, Credentials, CredentialError, NoticePayload } from "@lemma/contracts";

export type OAuthCredential = Extract<Credential, { readonly type: "oauth" }>;

/** What a login can do with the user: ask something, and tell them something (a link to open). */
export interface LoginUi {
  readonly ask: (message: string, options?: { readonly placeholder?: string; readonly secret?: boolean }) => Effect.Effect<string, LlmError>;
  readonly notify: (notice: NoticePayload) => Effect.Effect<void>;
}

/** A sign-in in the browser. */
export interface OAuthMethod {
  /** What the login offers, such as "Sign in with ChatGPT". */
  readonly name: string;
  readonly login: (ui: LoginUi) => Effect.Effect<OAuthCredential, LlmError>;
  /** The credential renewed. Runs under the credentials lock and is not interrupted, so a rotated token is kept. */
  readonly refresh: (credential: OAuthCredential) => Effect.Effect<OAuthCredential, LlmError>;
  /** Ends the session at the provider when the user logs out. */
  readonly revoke?: (credential: OAuthCredential) => Effect.Effect<void, LlmError>;
}

/**
 * How a provider authenticates. A stored login wins, whatever its type; without one, `key`, then the first of `env`
 * that is set.
 */
export interface ProviderAuth {
  /** Offers entering an API key at login, under this name ("OpenAI API key"). */
  readonly apiKey?: string;
  readonly oauth?: OAuthMethod;
  /** Environment variables that hold an API key, in order. */
  readonly env?: readonly string[];
  /** A key from config, or a placeholder for a keyless server. */
  readonly key?: { readonly token: string; readonly source: string };
}

export interface AuthProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: ProviderAuth;
}

/** What a request authenticates with. `source` says where it came from: `stored credential`, `OAuth`, an env var. */
export interface Token {
  readonly token: string;
  readonly source: string;
  readonly oauth: boolean;
}

/** A sign-in this close to expiring is renewed first, so a request never starts with a token about to lapse. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

const due = (credential: OAuthCredential) => {
  const now = Date.now();
  // A provider may ask not to be refreshed before a time; until then, a token that has not expired stands.
  const earliest = credential["earliestRefreshAt"];
  if (typeof earliest === "number" && earliest > now && credential.expires > now) return false;
  return credential.expires - now < RENEW_BEFORE_MS;
};

const failed = (reason: LlmError["reason"], prefix: string) => (error: CredentialError | LlmError) =>
  error._tag === "LlmError" ? error : new LlmError({ reason, message: `${prefix}: ${error.message}`, cause: error });

/** Logins and the tokens requests send, over the `Credentials` store. */
export function makeAuth(options: {
  readonly credentials: typeof Credentials.Service;
  readonly env: (name: string) => string | undefined;
  readonly ui: LoginUi;
}) {
  const { credentials, env, ui } = options;
  const read = (provider: AuthProvider) =>
    credentials.read(provider.id).pipe(Effect.mapError(failed("NotConfigured", `Could not read the ${provider.name} credential`)));

  const ambient = (auth: ProviderAuth): Token | undefined => {
    if (auth.key !== undefined) return { ...auth.key, oauth: false };
    for (const name of auth.env ?? []) {
      const value = env(name);
      if (value) return { token: value, source: name, oauth: false };
    }
    return undefined;
  };

  /** What a stored credential gives; an API key entry without a key counts as nothing stored. */
  const fromStored = (provider: AuthProvider, stored: Credential | undefined): Token | undefined => {
    if (stored === undefined || (stored.type === "api_key" && !stored.key)) return ambient(provider.auth);
    if (stored.type === "api_key") return provider.auth.apiKey === undefined ? undefined : { token: stored.key!, source: "stored credential", oauth: false };
    return provider.auth.oauth === undefined ? undefined : { token: stored.access, source: "OAuth", oauth: true };
  };

  /** What requests would send now, without the network: a sign-in due for renewal still counts. */
  const status = (provider: AuthProvider) => Effect.map(read(provider), (stored) => fromStored(provider, stored));

  /** The token for a request, renewing a stored sign-in that is due. Undefined when the provider is not configured. */
  const token = (provider: AuthProvider): Effect.Effect<Token | undefined, LlmError> =>
    Effect.gen(function* () {
      const stored = yield* read(provider);
      const oauth = provider.auth.oauth;
      if (stored?.type !== "oauth" || oauth === undefined || !due(stored)) return fromStored(provider, stored);
      // Checked again under the lock: another request, or another process, may have renewed it meanwhile.
      const renewed = yield* credentials
        .modify(provider.id, (current) => (current?.type === "oauth" && due(current) ? oauth.refresh(current) : Effect.succeed(undefined)))
        .pipe(
          Effect.uninterruptible,
          Effect.mapError(failed("NotConfigured", `Could not renew the ${provider.name} sign-in`)),
          // Renewal starts early: until the token expires, a failure to renew does not stop the request.
          Effect.catchAll((error) => (stored.expires > Date.now() ? Effect.succeed(stored) : Effect.fail(error))),
        );
      return fromStored(provider, renewed);
    });

  const login = (provider: AuthProvider, type: "api_key" | "oauth") =>
    Effect.gen(function* () {
      const oauth = provider.auth.oauth;
      if (type === "oauth" ? oauth === undefined : provider.auth.apiKey === undefined) {
        return yield* new LlmError({ reason: "LoginFailed", message: `${provider.name} does not support ${type === "oauth" ? "OAuth" : "API key"} login` });
      }
      const credential: Credential =
        type === "oauth" ? yield* oauth!.login(ui) : { type: "api_key", key: (yield* ui.ask(`Enter the ${provider.auth.apiKey}`, { secret: true })).trim() };
      if (credential.type === "api_key" && !credential.key)
        return yield* new LlmError({ reason: "LoginFailed", message: `No ${provider.auth.apiKey} was entered` });
      yield* credentials
        .modify(provider.id, () => Effect.succeed(credential))
        .pipe(Effect.mapError(failed("SaveFailed", `Could not save the ${provider.name} credential`)));
    });

  /**
   * Forgets the stored login, first ending a sign-in's session at the provider where it can. The session ended is the
   * one stored under the lock, not one a renewal has since replaced. A credential that cannot be read is forgotten too.
   */
  const logout = (provider: AuthProvider) =>
    Effect.gen(function* () {
      const revoke = provider.auth.oauth?.revoke;
      let unconfirmed: string | undefined;
      if (revoke !== undefined) {
        yield* credentials
          .modify(provider.id, (current) =>
            current?.type === "oauth"
              ? revoke(current).pipe(
                  Effect.catchAll((error) => Effect.sync(() => void (unconfirmed = error.message))),
                  Effect.as(undefined),
                )
              : Effect.succeed(undefined),
          )
          .pipe(Effect.catchAll((error) => Effect.sync(() => void (unconfirmed = error.message))));
      }
      yield* credentials.remove(provider.id).pipe(Effect.mapError(failed("SaveFailed", `Could not remove the ${provider.name} credential`)));
      if (unconfirmed !== undefined) {
        yield* ui.notify({
          level: "warning",
          source: "llm",
          message: `Logged out of ${provider.name} here, but it did not confirm ending the session (${unconfirmed}). You can end it in your account's settings.`,
        });
      }
    });

  return { status, token, login, logout };
}

export type Auth = ReturnType<typeof makeAuth>;
