import { Effect, Either, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { cleanupSessionResources, normalizeContext } from "@earendil-works/pi-ai";
import type { Api, Model, ProviderStreams, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Events, Hooks, PluginContext, definePlugin } from "@lemma/core";
import { Credentials, HostControl, Interaction, Llm, LlmError, LlmRequestHook, ModelsChanged, Notice, Paths, parseModelRef } from "@lemma/contracts";
import type { AuthType, LlmRequest, ProviderInfo, StreamEvent } from "@lemma/contracts";
import { makeAuth } from "./auth.ts";
import type { LoginUi, Token } from "./auth.ts";
import { networkSources, planSource, withLiveCatalog } from "./catalog.ts";
import { chatgptSignIn } from "./chatgpt.ts";
import { makeEventMapper, reasoningFor, toContext, toModelInfo } from "./convert.ts";
import { identityHeaders } from "./identity.ts";
import { CustomProvider, apis, builtinProviders, customEntry, customProvider, forPi, selectProviders } from "./providers.ts";
import type { LlmProvider } from "./providers.ts";

export const Config = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)).annotations({ description: "Built-in provider ids to offer; default all." }),
  exclude: Schema.optional(Schema.Array(Schema.String)).annotations({ description: "Built-in provider ids to leave out." }),
  providers: Schema.optional(Schema.Array(CustomProvider)).annotations({
    description: "Providers on a known wire API (OpenAI-compatible servers, proxies). Replace a built-in with the same id.",
  }),
  liveCatalogs: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    title: "Live model catalogs",
    description: "Add the models a built-in provider serves now (its model list, described by models.dev) to the ones this version knows.",
  }),
});
export type Config = typeof Config.Type;

export interface Options {
  /** Replaces the built-in providers (tests send through pi-ai's faux provider). Filtered by `include`/`exclude`. */
  readonly providers?: () => readonly LlmProvider[];
  /** Reads an environment variable for API keys; default `process.env`. */
  readonly env?: (name: string) => string | undefined;
  /** How catalogs and sign-ins reach the network; default the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export function toProviderInfo(provider: LlmProvider, token: Token | undefined): ProviderInfo {
  const { apiKey, oauth } = provider.auth;
  return {
    id: provider.id,
    name: provider.name,
    auth: [
      ...(apiKey === undefined ? [] : [{ type: "api_key" as const, name: apiKey, interactive: true }]),
      ...(oauth === undefined ? [] : [{ type: "oauth" as const, name: oauth.name, interactive: true }]),
    ],
    configured: token !== undefined,
    ...(token === undefined ? {} : { source: token.source }),
    ...(provider.custom === undefined ? {} : { custom: true }),
    ...(provider.custom?.logo === undefined ? {} : { logo: provider.custom.logo }),
  };
}

/** Header sets merged in order, a later name replacing an earlier one whatever its case. */
const mergeHeaders = (...sets: readonly (Readonly<Record<string, string>> | undefined)[]): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const set of sets) {
    for (const [name, value] of Object.entries(set ?? {})) {
      for (const existing of Object.keys(merged)) if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
      merged[name] = value;
    }
  }
  return merged;
};

/** One instance per wire API, made on first use; implementations load on first request. */
const wires = new Map<string, ProviderStreams>();
const wire = (api: string): ProviderStreams | undefined => {
  if (!Object.hasOwn(apis, api)) return undefined;
  let found = wires.get(api);
  if (found === undefined) wires.set(api, (found = apis[api as keyof typeof apis]()));
  return found;
};

export function makeLlmPlugin(options: Options = {}) {
  return definePlugin({
    id: "llm",
    config: Config,
    provides: [Llm],
    requires: [Credentials, Interaction, HostControl, Paths],
    layer: (config: Config) =>
      Layer.scoped(
        Llm,
        Effect.gen(function* () {
          const plugin = yield* PluginContext;
          const hooks = yield* Hooks;
          const events = yield* Events;
          const credentials = yield* Credentials;
          const interaction = yield* Interaction;
          const host = yield* HostControl;
          const { home } = yield* Paths;
          const fetchImpl = options.fetch ?? fetch;

          const ui: LoginUi = {
            ask: (message, askOptions) =>
              interaction.ask(message, askOptions).pipe(
                Effect.mapError(
                  (error) =>
                    new LlmError({
                      reason: error.reason === "Dismissed" ? "Cancelled" : "LoginFailed",
                      message: error.reason === "Dismissed" ? "The login was cancelled" : error.message,
                      cause: error,
                    }),
                ),
              ),
            notify: (notice) => events.publish(Notice, notice),
          };
          const auth = makeAuth({ credentials, env: options.env ?? ((name) => process.env[name]), ui });

          // A ChatGPT sign-in lists its plan's models, read from OpenAI, unless the lists are to stay pi-ai's.
          const plan = config.liveCatalogs ? planSource(fetchImpl) : undefined;
          const builtins = selectProviders(options.providers?.() ?? builtinProviders(chatgptSignIn({ home, fetch: fetchImpl }), plan), config);
          // A model a provider adds may be described already by another built-in provider's catalog.
          const siblings = () => builtins.flatMap((provider) => provider.catalog.models());
          const sources = networkSources(fetchImpl, siblings);
          const live = (provider: LlmProvider): LlmProvider =>
            provider.live === undefined ? provider : { ...provider, catalog: withLiveCatalog(provider.id, provider.catalog, sources, provider.live) };
          // The user's providers replace built-ins with the same id.
          const custom = new Map((config.providers ?? []).map((entry) => [entry.id, entry]));
          const providers = [
            ...builtins.filter((provider) => !custom.has(provider.id)).map((provider) => (config.liveCatalogs ? live(provider) : provider)),
            ...[...custom.values()].map(customProvider),
          ];
          const providerOf = (id: string) => providers.find((provider) => provider.id === id);

          /**
           * Saves a change to this plugin's own `providers` list, in the config file its config comes from; the host
           * reloads it, after replying when that restarts the caller's transport.
           */
          const saveProviders = (change: { readonly add?: readonly CustomProvider[]; readonly remove?: readonly string[] }) =>
            host.plugins
              .pipe(
                Effect.map((plugins) => plugins.find((info) => info.id === plugin.id)?.configScope),
                Effect.flatMap((scope) =>
                  host.configure(
                    {
                      [plugin.id]: {
                        ...(change.add === undefined ? {} : { add: { providers: change.add } }),
                        ...(change.remove === undefined ? {} : { remove: { providers: change.remove } }),
                      },
                    },
                    scope === "project" ? { scope } : undefined,
                  ),
                ),
              )
              .pipe(
                Effect.mapError(
                  (error) =>
                    new LlmError({ reason: "SaveFailed", message: error.diagnostics.map((diagnostic) => diagnostic.message).join("; "), cause: error }),
                ),
                Effect.asVoid,
              );
          const customOf = (providerId: string) =>
            Effect.suspend(() => {
              const entry = custom.get(providerId);
              return entry === undefined
                ? Effect.fail(new LlmError({ reason: "UnknownProvider", message: `No provider "${providerId}" was added by the user` }))
                : Effect.succeed(entry);
            });
          const providerFor = (providerId: string) =>
            Effect.suspend(() => {
              const provider = providerOf(providerId);
              return provider === undefined
                ? Effect.fail(new LlmError({ reason: "UnknownProvider", message: `Unknown provider: ${providerId}` }))
                : Effect.succeed(provider);
            });

          // Pooled websockets keep the event loop alive until released.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                cleanupSessionResources();
              } catch {
                // Best effort: a socket that fails to close cannot hold the plugin open.
              }
            }),
          );

          const listed = () => providers.flatMap((provider) => provider.catalog.models().map((model) => `${provider.id}/${model.id}`)).join("\n");
          // One refresh at a time, so an older one cannot finish after a newer one and bring back what it replaced.
          const refreshing = yield* Effect.makeSemaphore(1);
          /**
           * Updates provider catalogs (live catalogs, a ChatGPT plan's); failures keep the previous list. Clients hear
           * when the models changed, and list them again.
           */
          const refresh = (only?: readonly string[]) =>
            refreshing.withPermits(1)(
              Effect.gen(function* () {
                const before = listed();
                yield* Effect.forEach(
                  providers.filter((provider) => provider.catalog.refresh !== undefined && (only === undefined || only.includes(provider.id))),
                  (provider) =>
                    Effect.gen(function* () {
                      const token = yield* Effect.either(auth.token(provider));
                      // Not known to be signed out (a sign-in that could not be renewed just now): its list stands.
                      if (Either.isLeft(token)) return yield* Effect.logDebug(`llm: model refresh skipped for ${provider.id}: ${token.left.message}`);
                      yield* Effect.tryPromise((signal) => provider.catalog.refresh!({ auth: token.right, signal })).pipe(
                        Effect.catchAll((error) => Effect.logDebug(`llm: model refresh failed for ${provider.id}: ${String(error.error)}`)),
                      );
                    }),
                  { concurrency: "unbounded", discard: true },
                );
                if (listed() !== before) yield* events.publish(ModelsChanged, {});
              }),
            );
          // Now and every hour, so models a provider adds or retires show without a restart.
          yield* plugin.background("refresh models", Effect.repeat(refresh().pipe(Effect.ignore), Schedule.spaced("1 hour")));
          const scope = yield* Effect.scope;
          /**
           * Refreshes `only`, waiting for it up to 20 seconds. It may queue behind the hourly refresh, so it is not cut
           * off there: it finishes in the background and tells clients then.
           */
          const refreshAfterLogin = (only: readonly string[]) =>
            Effect.flatMap(Effect.forkIn(refresh(only).pipe(Effect.ignore), scope), (fiber) =>
              Fiber.join(fiber).pipe(Effect.timeout("20 seconds"), Effect.ignore),
            );

          const unknownModel = (ref: string) => new LlmError({ reason: "UnknownModel", message: `Unknown model: ${ref}. Model refs are <provider>/<model>.` });

          const findModel = (ref: string): { readonly provider: LlmProvider; readonly model: Model<Api> } | undefined => {
            const parsed = parseModelRef(ref);
            const provider = parsed === undefined ? undefined : providerOf(parsed.provider);
            const model = provider?.catalog.models().find((candidate) => candidate.id === parsed!.model);
            return provider === undefined || model === undefined ? undefined : { provider, model };
          };

          const terminal = (request: LlmRequest) =>
            Effect.gen(function* () {
              const found = findModel(request.model);
              if (found === undefined) return yield* Effect.fail(unknownModel(request.model));
              const { provider, model } = found;
              const mapper = makeEventMapper(model);
              // Auth problems end the stream with an error event that says what to do, as provider failures do.
              const token = yield* Effect.either(auth.token(provider));
              if (Either.isLeft(token) || token.right === undefined) {
                const reason = Either.isLeft(token)
                  ? token.left.message
                  : `${provider.name} is not authenticated. Run /login ${provider.id} or set its API key environment variable.`;
                return Stream.fromIterable(mapper.end(new Error(reason)));
              }
              const apiKey = token.right.token;
              const send = provider.stream ?? wire(model.api)?.streamSimple;
              if (send === undefined) return Stream.fromIterable(mapper.end(new Error(`${provider.name} cannot send to the "${model.api}" API`)));
              const reasoning = reasoningFor(model, request.thinking);
              // The model's own headers too: some wire APIs (pi-messages, Bedrock) send only the request's.
              const headers = mergeHeaders(model.headers, identityHeaders(model), provider.headers?.(request.sessionId));
              return Stream.asyncPush<StreamEvent>(
                (emit) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      const controller = new AbortController();
                      const streamOptions: SimpleStreamOptions = {
                        apiKey,
                        signal: controller.signal,
                        ...(Object.keys(headers).length === 0 ? {} : { headers }),
                        ...(reasoning === undefined ? {} : { reasoning }),
                        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
                        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
                      };
                      const out = (events: StreamEvent[]) => events.length > 0 && emit.array(events);
                      void (async () => {
                        try {
                          const sent = forPi(provider, model, normalizeContext(toContext(request)));
                          for await (const event of send(sent.model, sent.context, streamOptions)) {
                            out(mapper.push(event));
                            if (mapper.finished) break;
                          }
                          out(mapper.end());
                        } catch (error) {
                          out(mapper.end(error));
                        }
                        emit.end();
                      })();
                      return controller;
                    }),
                    // Interrupting the consumer aborts the provider request.
                    (controller) => Effect.sync(() => controller.abort()),
                  ),
                { bufferSize: "unbounded" },
              );
            });

          const status = (provider: LlmProvider) => auth.status(provider).pipe(Effect.orElseSucceed(() => undefined));

          return Llm.of({
            providers: Effect.forEach(providers, (provider) => Effect.map(status(provider), (token) => toProviderInfo(provider, token)), {
              concurrency: "unbounded",
            }),

            models: (query) =>
              Effect.map(
                Effect.filter(
                  providers,
                  (provider) => (query?.available === true ? Effect.map(status(provider), (token) => token !== undefined) : Effect.succeed(true)),
                  {
                    concurrency: "unbounded",
                  },
                ),
                (shown) => shown.flatMap((provider) => provider.catalog.models().map(toModelInfo)),
              ),

            model: (ref) => {
              const found = findModel(ref);
              return found === undefined ? Effect.fail(unknownModel(ref)) : Effect.succeed(toModelInfo(found.model));
            },

            stream: (request) =>
              Stream.unwrap(
                hooks.invoke(LlmRequestHook, request, terminal).pipe(
                  // Hook misuse and a closing core are defects here: the contract's error channel is LlmError.
                  Effect.catchAll((error) => (error._tag === "LlmError" ? Effect.fail(error) : Effect.die(error))),
                ),
              ),

            login: (providerId: string, type: AuthType) =>
              Effect.gen(function* () {
                const provider = yield* providerFor(providerId);
                yield* auth.login(provider, type);
                // Its catalog first, so clients that list models on hearing of the login see all of them.
                yield* refreshAfterLogin([providerId]);
                // Every client learns of it, including one that reloaded while the login ran.
                yield* events.publish(Notice, { level: "info", source: "llm", message: `Logged in to ${provider.name}` });
              }),

            logout: (providerId) =>
              Effect.gen(function* () {
                const provider = yield* providerFor(providerId);
                yield* auth.logout(provider);
                // Signed out of a plan, the provider's own list returns.
                yield* refreshAfterLogin([providerId]);
              }),

            addCustom: (spec) =>
              Effect.gen(function* () {
                const taken = new Set([...providers.map((provider) => provider.id), ...custom.keys()]);
                const entry = customEntry(spec, taken);
                if (entry === undefined) return yield* new LlmError({ reason: "InvalidProvider", message: `Unknown wire API "${spec.api}"` });
                yield* saveProviders({ add: [entry] });
                return entry.id;
              }),

            removeCustom: (providerId) => Effect.zipRight(customOf(providerId), saveProviders({ remove: [providerId] })),

            setLogo: (providerId, svg) =>
              Effect.flatMap(customOf(providerId), ({ logo: _logo, ...entry }) =>
                saveProviders({ add: [svg === undefined ? entry : { ...entry, logo: svg }] }),
              ),
          });
        }),
      ),
  });
}

export default makeLlmPlugin();

export { makeAuth } from "./auth.ts";
export type { Auth, AuthProvider, LoginUi, OAuthCredential, OAuthMethod, ProviderAuth, Token } from "./auth.ts";
export { fixedCatalog } from "./catalog.ts";
export type { Catalog, RefreshContext } from "./catalog.ts";
export { chatgptSignIn } from "./chatgpt.ts";
export { makeEventMapper, reasoningFor, toAssistantMessage, toContext, toModelInfo } from "./convert.ts";
export { CustomModel, CustomProvider, apis, builtinProviders, customModel, customProvider } from "./providers.ts";
export type { LlmProvider } from "./providers.ts";
