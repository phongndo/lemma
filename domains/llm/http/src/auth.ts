import { Effect } from "effect";
import type { Context } from "effect";
import { CredentialError } from "@lemma/credentials";
import type { Credential, Credentials } from "@lemma/credentials";
import { classifyFailure, JudgedError } from "./failure.ts";
import { ConnectionError, networkError, ProviderError } from "./http.ts";
import type { OAuthCredential, Provider } from "./providers.ts";
import type { Auth } from "./wire.ts";

type CredentialsService = Context.Service.Shape<typeof Credentials>;

/** Reads an environment variable: the process's, or what a test gives. */
export type Env = (name: string) => string | undefined;

/** Sent where a provider needs no key: OpenAI-compatible servers refuse an empty one, and local ones ignore it. */
const PLACEHOLDER = "unused";

const isOAuth = (credential: Credential | undefined): credential is Credential & OAuthCredential => credential?.type === "oauth";

/** The environment variable a provider's key is read from now, if any is set. */
const fromEnv = (provider: Provider, env: Env) => provider.apiKey.env.find((name) => (env(name) ?? "") !== "");

/**
 * Where a provider's requests would authenticate from now, as `ProviderInfo.source` says it, without refreshing
 * anything: a key stored by `/login`, a sign-in, the config, an environment variable, or none needed. Undefined: it
 * cannot authenticate.
 */
export function authSource(provider: Provider, stored: Credential | undefined, env: Env): string | undefined {
  if (stored?.type === "api_key" && stored.key) return "stored credential";
  if (isOAuth(stored) && provider.oauth !== undefined) return "OAuth";
  if (provider.apiKey.value !== undefined) return "config";
  const variable = fromEnv(provider, env);
  if (variable !== undefined) return variable;
  return provider.apiKey.keyless === true ? "no key required" : undefined;
}

/** How long a token refresh may take: it holds the credential's lock meanwhile. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * The key a request to `provider` sends, in the order `authSource` names them. A sign-in whose token has expired is
 * refreshed under the credential's lock (`Credentials.modify`), so two requests, or a request and a login, never
 * refresh it twice or overwrite each other. The refresh runs `detached` from the request, bounded by its own timeout:
 * once asked, the provider may have rotated the refresh token, so a request stopped meanwhile must not lose the new
 * one. Undefined: it cannot authenticate.
 */
export const resolveAuth = (
  provider: Provider,
  credentials: CredentialsService,
  env: Env,
  fetchImpl: typeof fetch,
  detached: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
): Effect.Effect<Auth | undefined, Error> =>
  Effect.gen(function* () {
    const stored = yield* Effect.mapError(credentials.read(provider.id), (error) => new Error(error.message));
    if (stored?.type === "api_key" && stored.key) return { key: stored.key, oauth: false };
    const oauth = provider.oauth;
    if (isOAuth(stored) && oauth !== undefined) {
      if (stored.expires > Date.now()) return { key: stored.access, oauth: true };
      const fresh = yield* detached(
        // Uninterruptible, the plugin stopping too: once asked, the provider may have rotated the refresh token, and the
        // new one is kept (stopping waits for it, `REFRESH_TIMEOUT_MS` at most).
        Effect.uninterruptible(
          credentials.modify(provider.id, (current) =>
            // Another request may have refreshed it while this one waited for the lock.
            isOAuth(current) && current.expires <= Date.now()
              ? Effect.tryPromise({
                  try: () => oauth.refresh(current, fetchImpl, AbortSignal.timeout(REFRESH_TIMEOUT_MS)) as Promise<Credential>,
                  catch: (error) => error,
                })
              : undefined,
          ),
        ),
      ).pipe(
        Effect.mapError((error) => {
          const message = `${provider.name} sign-in could not be refreshed`;
          // The store, not the sign-in, failed: busy (another process holds its lock) it may pass when asked again.
          if (error instanceof CredentialError) {
            return new JudgedError(`${message}: ${error.message}`, { kind: error.reason === "Locked" ? "transient" : "fatal" }, { cause: error });
          }
          // Judged as a request's failure is: only a refusal (the refresh token revoked or spent) needs a new sign-in;
          // the network, or the provider, failing may pass when asked again, and the sign-in is still good. Decided
          // here, where the cause is known, it travels with the error whatever its message says.
          const failed = error instanceof ProviderError || error instanceof ConnectionError ? error : networkError(error);
          const failure = classifyFailure(failed, failed.message);
          const detail = failed.message.replace(/\.+$/, "");
          const advice = failure.kind === "fatal" ? `. Run /login ${provider.id} to sign in again.` : "";
          return new JudgedError(`${message}: ${detail}${advice}`, failure, { cause: error });
        }),
      );
      if (isOAuth(fresh)) return { key: fresh.access, oauth: true };
      // Logged in with a key meanwhile.
      if (fresh?.type === "api_key" && fresh.key) return { key: fresh.key, oauth: false };
    }
    if (provider.apiKey.value !== undefined) return { key: provider.apiKey.value, oauth: false };
    const variable = fromEnv(provider, env);
    if (variable !== undefined) return { key: env(variable)!, oauth: false };
    return provider.apiKey.keyless === true ? { key: PLACEHOLDER, oauth: false } : undefined;
  });
