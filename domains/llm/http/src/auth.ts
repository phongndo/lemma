import { Deferred, Effect, Exit, Scope } from "effect";
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
 * How long the plugin may take to stop: for the one refresh a provider may have under way (`Refresher`), its own time
 * after waiting for the credential's lock (the file store gives up after 10 seconds), and its write.
 */
export const STOP_DEADLINE_MS = REFRESH_TIMEOUT_MS + 15_000;

/**
 * Runs sign-in refreshes in a scope of their own, which the plugin's closes: one a provider at a time, a request finding
 * its token expired joining the refresh under way rather than queueing another behind it. A refresh, once started,
 * finishes and keeps its token though the request or the plugin stops meanwhile, as the provider may have rotated the
 * refresh token once asked; one that has not asked it when the plugin starts stopping does not (`stopping`). So stopping
 * waits for one refresh a provider at most.
 */
export interface Refresher {
  /** `refresh` run uninterruptibly in the refreshes' scope, or the one under way for `id` joined; its caller may stop waiting. */
  readonly run: <A, E>(id: string, refresh: (stopping: () => boolean) => Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

export const makeRefresher: Effect.Effect<Refresher, never, Scope.Scope> = Effect.gen(function* () {
  const scope = yield* Scope.make();
  let stopping = false;
  // The word first, so a refresh still waiting for the credential's lock asks nothing; then those under way finish.
  yield* Effect.addFinalizer(() => Effect.sync(() => void (stopping = true)).pipe(Effect.andThen(Scope.close(scope, Exit.void))));
  const running = new Map<string, Deferred.Deferred<unknown, unknown>>();
  const run = <A, E>(id: string, refresh: (stopping: () => boolean) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const joined = running.get(id) as Deferred.Deferred<A, E> | undefined;
      if (joined !== undefined) return Deferred.await(joined);
      // Known before it starts, so a refresh ending at once is never left behind as the one under way.
      const done = Deferred.makeUnsafe<A, E>();
      running.set(id, done as Deferred.Deferred<unknown, unknown>);
      const settled = Effect.exit(refresh(() => stopping)).pipe(
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        Effect.ensuring(Effect.sync(() => void (running.get(id) === done && running.delete(id)))),
      );
      // Uninterruptible from its start, so it settles `done` though stopping interrupts it before it runs.
      return Effect.forkIn(settled, scope, { uninterruptible: true }).pipe(Effect.andThen(Deferred.await(done)));
    });
  return { run };
});

/**
 * The key a request to `provider` sends, in the order `authSource` names them. A sign-in whose token has expired is
 * refreshed under the credential's lock (`Credentials.modify`), so two requests, or a request and a login, never
 * refresh it twice or overwrite each other, by the plugin's `Refresher`, bounded by its own timeout. Undefined: it cannot
 * authenticate.
 */
export const resolveAuth = (
  provider: Provider,
  credentials: CredentialsService,
  env: Env,
  fetchImpl: typeof fetch,
  refresher: Refresher,
): Effect.Effect<Auth | undefined, Error> =>
  Effect.gen(function* () {
    const stored = yield* Effect.mapError(credentials.read(provider.id), (error) => new Error(error.message));
    if (stored?.type === "api_key" && stored.key) return { key: stored.key, oauth: false };
    const oauth = provider.oauth;
    if (isOAuth(stored) && oauth !== undefined) {
      if (stored.expires > Date.now()) return { key: stored.access, oauth: true };
      const fresh = yield* refresher
        .run(provider.id, (stopping) =>
          credentials.modify(provider.id, (current) =>
            // Another request may have refreshed it while this one waited for the lock, and a plugin stopping asks nothing.
            isOAuth(current) && current.expires <= Date.now() && !stopping()
              ? Effect.tryPromise({
                  try: () => oauth.refresh(current, fetchImpl, AbortSignal.timeout(REFRESH_TIMEOUT_MS)) as Promise<Credential>,
                  catch: (error) => error,
                })
              : undefined,
          ),
        )
        .pipe(
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
      // Not refreshed, as the plugin is stopping: a request then may be asked again of the next.
      if (isOAuth(fresh) && fresh.expires <= Date.now()) {
        return yield* Effect.fail(new JudgedError(`${provider.name} sign-in was not refreshed: Lemma's model plugin is stopping`, { kind: "transient" }));
      }
      if (isOAuth(fresh)) return { key: fresh.access, oauth: true };
      // Logged in with a key meanwhile.
      if (fresh?.type === "api_key" && fresh.key) return { key: fresh.key, oauth: false };
    }
    if (provider.apiKey.value !== undefined) return { key: provider.apiKey.value, oauth: false };
    const variable = fromEnv(provider, env);
    if (variable !== undefined) return { key: env(variable)!, oauth: false };
    return provider.apiKey.keyless === true ? { key: PLACEHOLDER, oauth: false } : undefined;
  });
