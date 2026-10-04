import { Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import { cleanupSessionResources, createModels } from "@earendil-works/pi-ai";
import type { AuthCheck, AuthContext, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Events, Hooks, PluginContext, definePlugin } from "@lemma/core";
import { Credentials, HostControl, Interaction, InteractionError, Llm, LlmError, LlmRequestHook, Notice, Paths, parseModelRef } from "@lemma/contracts";
import type { AuthType, LlmRequest, NoticePayload, ProviderInfo, StreamEvent } from "@lemma/contracts";
import { authInteraction, credentialStore, runner, toNotice } from "./auth.ts";
import { makeEventMapper, reasoningFor, toContext, toModelInfo } from "./convert.ts";
import { networkSources, withLiveCatalog } from "./catalog.ts";
import { deviceId } from "./device.ts";
import { CustomProvider, customEntry, customProvider, selectProviders, withoutAnthropicOAuth } from "./providers.ts";

export const Config = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)).annotations({ description: "Built-in provider ids to register; default all." }),
  exclude: Schema.optionalWith(Schema.Array(Schema.String), { default: () => ["openai-codex"] }).annotations({
    description: "Built-in provider ids to leave out. Default: the legacy openai-codex, whose ChatGPT sign-in openai now offers.",
  }),
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
  /** Replaces pi-ai's built-in provider list (tests register the faux provider here). Filtered by `include`/`exclude`. */
  readonly providers?: () => readonly Provider[];
  /** Environment used for auth resolution; default `process.env` and the filesystem. */
  readonly authContext?: AuthContext;
  /** How live catalogs are fetched; default the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** `custom`: the user's entry for a provider they added (`true` when only that much is known). */
export function toProviderInfo(provider: Provider, check: AuthCheck | undefined, custom: CustomProvider | boolean = false): ProviderInfo {
  const { apiKey, oauth } = provider.auth;
  return {
    id: provider.id,
    name: provider.name,
    auth: [
      ...(apiKey === undefined ? [] : [{ type: "api_key" as const, name: apiKey.name, interactive: apiKey.login !== undefined }]),
      ...(oauth === undefined ? [] : [{ type: "oauth" as const, name: oauth.loginLabel ?? oauth.name, interactive: true }]),
    ],
    configured: check !== undefined,
    ...(check?.source === undefined ? {} : { source: check.source }),
    ...(custom === false ? {} : { custom: true }),
    ...(typeof custom === "object" && custom.logo !== undefined ? { logo: custom.logo } : {}),
  };
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function loginError(error: unknown, provider: Provider): LlmError {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : undefined;
  const dismissed = [error, cause].some((e) => e instanceof InteractionError && e.reason === "Dismissed");
  if (dismissed || isAbort(error)) {
    return new LlmError({ reason: "Cancelled", message: `${provider.name} login was cancelled`, cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LlmError({ reason: "LoginFailed", message: `${provider.name} login failed: ${detail}`, cause: error });
}

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
          const run = runner(yield* Effect.runtime<never>());

          const models = createModels({
            credentials: credentialStore(credentials, run),
            ...(options.authContext === undefined ? {} : { authContext: options.authContext }),
          });
          const builtins = selectProviders((options.providers ?? builtinProviders)(), config).map(withoutAnthropicOAuth);
          // A missing model may be described already by another built-in provider's catalog.
          const siblings = () => builtins.flatMap((provider) => provider.getModels());
          const sources = networkSources(options.fetch ?? fetch, siblings);
          for (const provider of builtins) models.setProvider(config.liveCatalogs ? withLiveCatalog(provider, sources) : provider);
          for (const provider of config.providers ?? []) models.setProvider(customProvider(provider));
          const custom = new Map((config.providers ?? []).map((provider) => [provider.id, provider]));
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

          // Pooled Codex websockets keep the event loop alive until released.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                cleanupSessionResources();
              } catch {
                // Best effort: a socket that fails to close cannot hold the plugin open.
              }
            }),
          );

          /** Updates provider catalogs (live catalogs, and Radius's own); failures keep the previous list. */
          const refresh = (providers?: readonly string[]) =>
            Effect.tryPromise((signal) => models.refresh({ signal, ...(providers === undefined ? {} : { providers }) })).pipe(
              Effect.tap(({ errors }) => Effect.forEach(errors, ([id, error]) => Effect.logDebug(`llm: model refresh failed for ${id}: ${error.message}`))),
            );
          yield* plugin.background("refresh models", refresh());

          const unknownModel = (ref: string) => new LlmError({ reason: "UnknownModel", message: `Unknown model: ${ref}. Model refs are <provider>/<model>.` });

          const findModel = (ref: string) => {
            const parsed = parseModelRef(ref);
            return parsed === undefined ? undefined : models.getModel(parsed.provider, parsed.model);
          };

          const terminal = (request: LlmRequest) =>
            Effect.gen(function* () {
              const model = findModel(request.model);
              const provider = model === undefined ? undefined : models.getProvider(model.provider);
              if (model === undefined || provider === undefined) return yield* Effect.fail(unknownModel(request.model));
              const reasoning = reasoningFor(model, request.thinking);
              return Stream.asyncPush<StreamEvent>(
                (emit) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      const controller = new AbortController();
                      const streamOptions: SimpleStreamOptions = {
                        signal: controller.signal,
                        ...(reasoning === undefined ? {} : { reasoning }),
                        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
                        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
                      };
                      const mapper = makeEventMapper(model, provider);
                      const send = (out: StreamEvent[]) => out.length > 0 && emit.array(out);
                      void (async () => {
                        try {
                          for await (const event of models.streamSimple(model, toContext(request), streamOptions)) {
                            send(mapper.push(event));
                            if (mapper.finished) break;
                          }
                          send(mapper.end());
                        } catch (error) {
                          send(mapper.end(error));
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

          return Llm.of({
            providers: Effect.forEach(
              models.getProviders(),
              (provider) =>
                Effect.tryPromise((signal) => models.checkAuth(provider.id, { signal })).pipe(
                  Effect.orElseSucceed(() => undefined),
                  Effect.map((check) => toProviderInfo(provider, check, custom.get(provider.id) ?? false)),
                ),
              { concurrency: "unbounded" },
            ),

            models: (query) =>
              query?.available === true
                ? Effect.forEach(
                    models.getProviders(),
                    (provider) => Effect.tryPromise((signal) => models.getAvailable(provider.id, { signal })).pipe(Effect.orElseSucceed(() => [])),
                    { concurrency: "unbounded" },
                  ).pipe(Effect.map((lists) => lists.flat().map(toModelInfo)))
                : Effect.sync(() => models.getModels().map(toModelInfo)),

            model: (ref) => {
              const model = findModel(ref);
              return model === undefined ? Effect.fail(unknownModel(ref)) : Effect.succeed(toModelInfo(model));
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
                const provider = models.getProvider(providerId);
                if (provider === undefined) {
                  return yield* Effect.fail(new LlmError({ reason: "UnknownProvider", message: `Unknown provider: ${providerId}` }));
                }
                const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
                if (method?.login === undefined) {
                  const kind = type === "oauth" ? "OAuth" : "API key";
                  return yield* Effect.fail(new LlmError({ reason: "LoginFailed", message: `${provider.name} does not support ${kind} login` }));
                }
                // Provider flows notify synchronously; a queue keeps notices ordered, and
                // `undefined` ends it so every notice is published before login returns.
                const notices = yield* Queue.unbounded<NoticePayload | undefined>();
                const publishAll: Effect.Effect<void> = Queue.take(notices).pipe(
                  Effect.flatMap((notice) =>
                    notice === undefined
                      ? Effect.void
                      : Effect.zipRight(
                          events.publish(Notice, notice),
                          Effect.suspend(() => publishAll),
                        ),
                  ),
                );
                const publisher = yield* Effect.fork(publishAll);
                const flush = Effect.zipRight(Queue.offer(notices, undefined), Fiber.join(publisher));
                yield* Effect.tryPromise({
                  try: (signal) =>
                    models.login(
                      providerId,
                      type,
                      authInteraction(interaction, run, signal, (event) => {
                        Queue.unsafeOffer(notices, toNotice(event, provider.name));
                      }),
                      { getDeviceId: () => deviceId(home) },
                    ),
                  catch: (error) => loginError(error, provider),
                }).pipe(Effect.ensuring(flush));
                // Its live catalog first, so clients that list models on hearing of the login see all of them.
                yield* refresh([providerId]).pipe(Effect.timeout("20 seconds"), Effect.ignore);
                // Every client learns of it, including one that reloaded while the login ran.
                yield* events.publish(Notice, { level: "info", source: "llm", message: `Logged in to ${provider.name}` });
              }),

            logout: (providerId) =>
              Effect.tryPromise({
                try: (signal) => models.logout(providerId, { signal }),
                catch: (error) =>
                  new LlmError({
                    reason: "LoginFailed",
                    message: `Could not remove the ${providerId} credential: ${error instanceof Error ? error.message : String(error)}`,
                    cause: error,
                  }),
              }),

            addCustom: (spec) =>
              Effect.gen(function* () {
                const taken = new Set([...models.getProviders().map((provider) => provider.id), ...custom.keys()]);
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

export { authInteraction, credentialStore, runner, toNotice } from "./auth.ts";
export { explainError, makeEventMapper, reasoningFor, toAssistantMessage, toContext, toModelInfo } from "./convert.ts";
export { CustomModel, CustomProvider, apis, customModel, customProvider, withoutAnthropicOAuth } from "./providers.ts";
