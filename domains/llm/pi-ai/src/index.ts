import { Cause, Effect, Fiber, Queue, Schedule, Schema, Stream } from "effect";
import { cleanupSessionResources, createModels } from "@earendil-works/pi-ai";
import type { AuthCheck, AuthContext, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Events, Hooks, Registries, definePlugin } from "@lemma/core";
import type { Contribution, HandlerStep } from "@lemma/core";
import { Channels, creditOf, HostControl, inChainOrder, Interaction, InteractionError, InteractionOrigin, Notice, Paths } from "@lemma/contracts";
import { Credentials } from "@lemma/credentials";
import {
  Llm,
  LLM_CONTRACT,
  LlmError,
  LlmProviderHeadersHook,
  LlmProviderResponse,
  LlmProviderStreamEvent,
  ModelsChanged,
  parseModelRef,
  Providers,
  serveLlm,
  streamThroughHook,
} from "@lemma/llm";
import type { NoticePayload } from "@lemma/contracts";
import type { AuthType, LlmRequest, ProviderHeaders, ProviderInfo, ProviderSpec, StreamEvent } from "@lemma/llm";
import { authInteraction, credentialStore, runner, toNotice } from "./auth.ts";
import {
  makeEventMapper,
  reasoningFor,
  toClassifierContext,
  toClassifierInfo,
  toClassifierResult,
  toContext,
  toImageModelInfo,
  toImagesContext,
  toImagesResult,
  toModelInfo,
} from "./convert.ts";
import { networkSources, planSource, withLiveCatalog, withPlanCatalog } from "./catalog.ts";
import { deviceId } from "./device.ts";
import { identityHeaders } from "./identity.ts";
import { CustomProvider, customEntry, customProvider, knownApi, selectProviders, withBuiltinIdentity, withoutAnthropicOAuth } from "./providers.ts";

const Config = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Built-in provider ids to register; default all." }),
  exclude: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => ["openai-codex"])))
    .annotate({
      description: "Built-in provider ids to leave out. Default: the legacy openai-codex, whose ChatGPT sign-in openai now offers.",
    }),
  providers: Schema.optional(Schema.Array(CustomProvider)).annotate({
    description: "Providers on a known wire API (OpenAI-compatible servers, proxies). Replace a built-in with the same id.",
  }),
  liveCatalogs: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Live model catalogs",
    description: "Add the models a built-in provider serves now (its model list, described by models.dev) to the ones this version knows.",
  }),
  streamTimeout: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 300)))
    .annotate({
      title: "Stream timeout",
      description: "Seconds a model response may go without sending anything (its first event, or the next) before it fails as stalled. 0: wait forever.",
    }),
  cacheRetention: Schema.Literals(["short", "long"])
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => "short" as const)))
    .annotate({
      title: "Prompt cache retention",
      description: "How long providers keep a session's prompt cache: short (about 5 minutes) or long (an hour, where offered; writing it costs more).",
    }),
  providerEvents: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))).annotate({
    title: "Provider events",
    description: "Publish each event of a provider's stream as it sent it (LlmProviderStreamEvent), for debugging an adapter. Costly; off by default.",
  }),
});
type Config = typeof Config.Type;

/** The response header a provider names its request id in, by the names providers use (not a CDN's trace id). */
const REQUEST_ID_HEADERS = ["request-id", "x-request-id", "openai-request-id", "x-amzn-requestid", "x-goog-request-id"];
const requestIdOf = (headers: Readonly<Record<string, string>>): string | undefined => {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return REQUEST_ID_HEADERS.map((name) => lower.get(name)).find((value) => value !== undefined);
};

type Headers = Readonly<Record<string, string | null>>;
/** The headers whose values differ between `before` and `after`, by name. */
const headerChanges = (before: Headers, after: Headers): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort();

/** What `providerOptions` (`LlmRequest`) pi-ai passes on: a temperature, sampling parameters, and metadata. */
const passedOn = (options: LlmRequest["providerOptions"]): Pick<SimpleStreamOptions, "temperature" | "samplingParams" | "metadata"> => {
  if (options === undefined) return {};
  const record = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  const temperature = typeof options.temperature === "number" ? options.temperature : undefined;
  const samplingParams = record(options.samplingParams);
  const metadata = record(options.metadata);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    ...(metadata === undefined ? {} : { metadata }),
  };
};

/**
 * Times pi-ai asks again itself, before a response starts, when the provider
 * fails in a way its SDK would retry (pi-ai makes none unless told). It waits
 * the delay the provider names (`Retry-After`) up to a minute; a longer one it
 * reports in the error, for the caller to wait out.
 */
const SDK_RETRIES = 2;

interface Options {
  /** Replaces pi-ai's built-in provider list (tests register the faux provider here). Filtered by `include`/`exclude`. */
  readonly providers?: () => readonly Provider[];
  /** Environment used for auth resolution; default `process.env` and the filesystem. */
  readonly authContext?: AuthContext;
  /** How live catalogs are fetched; default the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** `custom`: the user's entry for a provider they added; `from`: the plugin that added it to `Providers`. */
function toProviderInfo(
  provider: Provider,
  check: AuthCheck | undefined,
  custom: CustomProvider | undefined,
  from: Contribution<ProviderSpec> | undefined,
): ProviderInfo {
  // The user's logo for their own provider; a plugin's provider brings its own.
  const logo = custom?.logo ?? from?.item.logo;
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
    ...(custom === undefined ? {} : { custom: true }),
    ...(logo === undefined ? {} : { logo }),
    ...(from === undefined ? {} : { from: from.pluginId }),
  };
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function loginError(error: unknown, provider: Provider): LlmError {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : undefined;
  const dismissed = [error, cause].some((e) => e instanceof InteractionError && e.reason === "Dismissed");
  if (dismissed || isAbort(error)) {
    return new LlmError({ reason: "Cancelled", provider: provider.id, message: `${provider.name} login was cancelled`, cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LlmError({ reason: "LoginFailed", provider: provider.id, message: `${provider.name} login failed: ${detail}`, cause: error });
}

export function makeLlmPlugin(options: Options = {}) {
  return definePlugin({
    id: "llm.pi-ai",
    implements: [LLM_CONTRACT],
    version: "0.1.0",
    config: Config,
    provides: { llm: Llm },
    requires: { credentials: Credentials, interaction: Interaction, host: HostControl, paths: Paths },
    setup: function* ({ credentials, interaction, host, paths }, plugin) {
      const config = plugin.config;
      const hooks = yield* Hooks;
      const events = yield* Events;
      const { home } = paths;
      const run = runner(yield* Effect.context<never>());
      const scope = yield* Effect.scope;

      const models = createModels({
        credentials: credentialStore(credentials, run),
        ...(options.authContext === undefined ? {} : { authContext: options.authContext }),
      });
      // A missing model may be described already by another built-in provider's catalog.
      const siblings = () => builtins.flatMap((provider) => provider.getModels());
      const sources = networkSources(options.fetch ?? fetch, siblings);
      const plan = planSource(options.fetch ?? fetch);
      // OpenAI signed in with ChatGPT lists the plan's models, as the Codex CLI and app do, not the API's.
      const live = (provider: Provider) => {
        const caught = withLiveCatalog(provider, sources);
        return provider.id === "openai" ? withPlanCatalog(caught, plan) : caught;
      };
      // Live catalogs use the upstream id; filters and every public model ref use Lemma's stable identity.
      const builtins = selectProviders(
        (options.providers ?? builtinProviders)().map((provider) => withBuiltinIdentity(config.liveCatalogs ? live(provider) : provider)),
        config,
      ).map(withoutAnthropicOAuth);
      for (const provider of builtins) models.setProvider(provider);
      for (const provider of config.providers ?? []) models.setProvider(customProvider(provider));
      const custom = new Map((config.providers ?? []).map((provider) => [provider.id, provider]));
      /**
       * Saves a change to this plugin's own `providers` list, in the config file its config comes from. The change
       * restarts this plugin, so the host applies it once the work asking for it has ended (`ChangeReport`): a
       * client's call returns first.
       */
      const saveProviders = (provider: string, change: { readonly add?: readonly CustomProvider[]; readonly remove?: readonly string[] }) =>
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
                new LlmError({ reason: "SaveFailed", provider, message: error.diagnostics.map((diagnostic) => diagnostic.message).join("; "), cause: error }),
            ),
            Effect.asVoid,
          );
      const customOf = (providerId: string) =>
        Effect.suspend(() => {
          const entry = custom.get(providerId);
          return entry === undefined
            ? Effect.fail(new LlmError({ reason: "UnknownProvider", provider: providerId, message: `No provider "${providerId}" was added by the user` }))
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

      const listed = () =>
        models
          .getProviders()
          .flatMap((provider) => provider.getModels().map((model) => `${provider.id}/${model.id}`))
          .join("\n");
      /** Clients hear that what `providers` and `models` list changed, and list them again. */
      const announce = events.publish(ModelsChanged, {});
      /**
       * Updates provider catalogs (live catalogs, a ChatGPT plan's, Radius's own); failures keep the previous list.
       * Whether the models listed changed.
       */
      const refresh = (providers?: readonly string[]) =>
        Effect.gen(function* () {
          const before = listed();
          const result = yield* Effect.tryPromise((signal) => models.refresh({ signal, ...(providers === undefined ? {} : { providers }) }));
          yield* Effect.forEach(result.errors, ([id, error]) => Effect.logDebug(`llm: model refresh failed for ${id}: ${error.message}`));
          return listed() !== before;
        });
      /**
       * After a login or logout: the provider's catalog first, so clients listing on hearing of it see all of it, then
       * `announce` even when the models stayed the same, since what is configured and available changed.
       */
      const authChanged = (providerId: string) => refresh([providerId]).pipe(Effect.timeout("20 seconds"), Effect.ignore, Effect.andThen(announce));
      /** The providers plugins added (`Providers`) that it serves, by id. */
      let added = new Map<string, Contribution<ProviderSpec>>();
      /** The providers left out, and said so: each is warned of once, not again on every later change. */
      const warned = new Set<ProviderSpec>();
      /** Serves what `Providers` holds now: each added, changed, or gone, and clients told when any is. */
      const syncAdded = (items: readonly Contribution<ProviderSpec>[]) =>
        Effect.gen(function* () {
          const next = new Map<string, Contribution<ProviderSpec>>();
          for (const contribution of items) {
            const { id, api } = contribution.item;
            const leftOut = !knownApi(api)
              ? `speaks "${api}", which this plugin does not`
              : builtins.some((provider) => provider.id === id) || custom.has(id)
                ? "is left out: a built-in or the user's provider has its id"
                : undefined;
            if (leftOut === undefined) next.set(id, contribution);
            else if (!warned.has(contribution.item)) {
              warned.add(contribution.item);
              yield* Effect.logWarning(`llm: ${contribution.pluginId}'s provider "${id}" ${leftOut}`);
            }
          }
          const changed = [...added.keys()].some((id) => !next.has(id)) || [...next].some(([id, contribution]) => added.get(id)?.item !== contribution.item);
          for (const id of added.keys()) if (!next.has(id)) models.deleteProvider(id);
          for (const [id, contribution] of next) {
            if (added.get(id)?.item !== contribution.item)
              models.setProvider(customProvider({ ...contribution.item, api: contribution.item.api as CustomProvider["api"] }));
          }
          added = next;
          return changed;
        });
      const registries = yield* Registries;
      yield* syncAdded(yield* registries.items(Providers));
      // Every list, the first too: one added before this stream started is in it. One unchanged changes nothing.
      yield* plugin.background(
        "providers",
        Stream.runForEach(registries.changes(Providers), (items) => Effect.flatMap(syncAdded(items), (changed) => (changed ? announce : Effect.void))),
      );

      // Now and every hour, so models a provider adds or retires show without a restart.
      yield* plugin.background(
        "refresh models",
        Effect.repeat(
          refresh().pipe(
            Effect.flatMap((changed) => (changed ? announce : Effect.void)),
            Effect.ignore,
          ),
          Schedule.spaced("1 hour"),
        ),
      );

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
          // Plugins may add, change, or drop headers, over what would be sent (the model's own and Lemma's User-Agent);
          // who changed which is told back with the answer, values never.
          const steps: HandlerStep<ProviderHeaders, Headers>[] = [];
          const headers = yield* hooks
            .invoke(
              LlmProviderHeadersHook,
              { request, provider: model.provider, headers: { ...model.headers, ...identityHeaders(model) } },
              (input) => Effect.succeed(input.headers),
              {
                onStep: (step) => void steps.push(step),
              },
            )
            .pipe(Effect.orDie);
          const handlers = inChainOrder(steps).map((step) =>
            creditOf(step, [
              ...new Set([
                ...(step.next === undefined ? [] : headerChanges(step.input.headers, step.next.input.headers)),
                ...(step.output === undefined ? [] : headerChanges(step.next?.output ?? step.input.headers, step.output)),
              ]),
            ]),
          );
          const where = { ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }), provider: model.provider, model: request.model };
          return Stream.callback<StreamEvent>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const controller = new AbortController();
                const mapper = makeEventMapper(model, provider);
                let closed = false;
                /** The provider's answer, held until `start` has gone out: a stream begins with `start`. */
                let answer: StreamEvent | undefined;
                let told = false;
                let started = false;
                const send = (out: StreamEvent[]) => {
                  if (closed || out.length === 0) return;
                  // A request that failed before the provider answered (refused before its body, or never sent) still says
                  // who shaped its headers.
                  if (!told && answer === undefined && handlers.length > 0 && out.some((event) => event.type === "error")) {
                    answer = { type: "provider", credit: { handlers } };
                  }
                  // Where in `out` what was held goes: right after its `start`, first once the stream has started, or
                  // before an error that came with no `start`.
                  const startAt = out.findIndex((event) => event.type === "start");
                  if (startAt >= 0) started = true;
                  const at = startAt >= 0 ? startAt + 1 : started ? 0 : out.findIndex((event) => event.type === "error");
                  if (answer !== undefined && at >= 0) {
                    out = [...out.slice(0, at), answer, ...out.slice(at)];
                    answer = undefined;
                    told = true;
                  }
                  Queue.offerAllUnsafe(queue, out);
                };
                const streamOptions: SimpleStreamOptions = {
                  signal: controller.signal,
                  cacheRetention: config.cacheRetention,
                  maxRetries: SDK_RETRIES,
                  ...(Object.keys(headers).length === 0 ? {} : { headers }),
                  ...(reasoning === undefined ? {} : { reasoning }),
                  ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
                  ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
                  ...passedOn(request.providerOptions),
                  // Before its body: told to the caller, logged with the answer, and published.
                  onResponse: (response) => {
                    const requestId = requestIdOf(response.headers);
                    answer = {
                      type: "provider",
                      status: response.status,
                      ...(requestId === undefined ? {} : { requestId }),
                      ...(handlers.length === 0 ? {} : { credit: { handlers } }),
                    };
                    Effect.runFork(events.publish(LlmProviderResponse, { ...where, status: response.status, headers: response.headers }));
                  },
                  ...(config.providerEvents
                    ? { onProviderStreamEvent: (data: unknown) => void Effect.runFork(events.publish(LlmProviderStreamEvent, { ...where, data })) }
                    : {}),
                };
                const close = (out: StreamEvent[]) => {
                  send(out);
                  if (!closed) Queue.endUnsafe(queue);
                  closed = true;
                };
                // A response that sends nothing for `streamTimeout` ends at once as a transient failure, and the
                // request is aborted: a half-open connection would otherwise hold the turn forever.
                const idleMs = config.streamTimeout * 1000;
                let stalled = false;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const arm = () => {
                  if (idleMs <= 0) return;
                  clearTimeout(timer);
                  timer = setTimeout(() => {
                    stalled = true;
                    close(
                      mapper.end(new Error(`The model sent nothing for ${config.streamTimeout} seconds; the request was cut off as stalled`), {
                        kind: "transient",
                      }),
                    );
                    controller.abort();
                  }, idleMs);
                };
                void (async () => {
                  arm();
                  try {
                    for await (const event of models.streamSimple(model, toContext(request, model), streamOptions)) {
                      if (stalled) break;
                      arm();
                      send(mapper.push(event));
                      if (mapper.finished) break;
                    }
                    close(mapper.end());
                  } catch (error) {
                    close(mapper.end(error));
                  } finally {
                    clearTimeout(timer);
                  }
                })();
                return () => {
                  clearTimeout(timer);
                  controller.abort();
                };
              }),
              // Interrupting the consumer aborts the provider request.
              (stop) => Effect.sync(stop),
            ),
          );
        });

      const llm = Llm.of({
        // Read when asked: the providers plugins add come and go while it runs.
        providers: Effect.suspend(() =>
          Effect.forEach(
            models.getProviders(),
            (provider) =>
              Effect.tryPromise((signal) => models.checkAuth(provider.id, { signal })).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.map((check) => toProviderInfo(provider, check, custom.get(provider.id), added.get(provider.id))),
              ),
            { concurrency: "unbounded" },
          ),
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

        stream: (request) => streamThroughHook(hooks, request, terminal),

        classifiers: (query) =>
          query?.available === true
            ? Effect.forEach(
                models.getProviders(),
                (provider) =>
                  Effect.tryPromise((signal) => models.getAvailableOfType("classifier", provider.id, { signal })).pipe(Effect.orElseSucceed(() => [])),
                { concurrency: "unbounded" },
              ).pipe(Effect.map((lists) => lists.flat().map(toClassifierInfo)))
            : Effect.sync(() => models.getModelsOfType("classifier").map(toClassifierInfo)),

        classify: (ref, context) =>
          Effect.gen(function* () {
            const parsed = parseModelRef(ref);
            const model = parsed === undefined ? undefined : models.getModelOfType("classifier", parsed.provider, parsed.model);
            if (model === undefined) return yield* Effect.fail(unknownModel(ref));
            const headers = identityHeaders(model);
            // pi-ai's classify never rejects: a provider's failure, or missing auth, is the result's error.
            const result = yield* Effect.promise((signal) =>
              models.classify(model, toClassifierContext(context), { signal, ...(headers === undefined ? {} : { headers }) }),
            );
            return toClassifierResult(result);
          }),

        imageModels: (query) =>
          query?.available === true
            ? Effect.forEach(
                models.getProviders(),
                (provider) => Effect.tryPromise((signal) => models.getAvailableOfType("image", provider.id, { signal })).pipe(Effect.orElseSucceed(() => [])),
                { concurrency: "unbounded" },
              ).pipe(Effect.map((lists) => lists.flat().map(toImageModelInfo)))
            : Effect.sync(() => models.getModelsOfType("image").map(toImageModelInfo)),

        generateImages: (ref, context) =>
          Effect.gen(function* () {
            const parsed = parseModelRef(ref);
            const model = parsed === undefined ? undefined : models.getModelOfType("image", parsed.provider, parsed.model);
            if (model === undefined) return yield* Effect.fail(unknownModel(ref));
            const headers = identityHeaders(model);
            // Like classify: a provider's failure, or missing auth, is the result's error.
            const result = yield* Effect.promise((signal) =>
              models.generateImages(model, toImagesContext(context), { signal, ...(headers === undefined ? {} : { headers }) }),
            );
            return toImagesResult(result);
          }),

        login: (providerId: string, type: AuthType) =>
          Effect.gen(function* () {
            const provider = models.getProvider(providerId);
            if (provider === undefined) {
              return yield* Effect.fail(new LlmError({ reason: "UnknownProvider", provider: providerId, message: `Unknown provider: ${providerId}` }));
            }
            const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
            if (method?.login === undefined) {
              const kind = type === "oauth" ? "OAuth" : "API key";
              return yield* Effect.fail(
                new LlmError({ reason: "LoginFailed", provider: providerId, message: `${provider.name} does not support ${kind} login` }),
              );
            }
            // Provider flows notify synchronously; a queue keeps notices ordered, and
            // `undefined` ends it so every notice is published before login returns.
            const notices = yield* Queue.unbounded<NoticePayload | undefined>();
            // Its questions and its link or code share the origin, so a client shows them together.
            const origin = yield* InteractionOrigin;
            const publishAll: Effect.Effect<void> = Queue.take(notices).pipe(
              Effect.flatMap((notice) =>
                notice === undefined
                  ? Effect.void
                  : Effect.andThen(
                      events.publish(Notice, notice),
                      Effect.suspend(() => publishAll),
                    ),
              ),
            );
            const publisher = yield* Effect.forkChild(publishAll);
            const flush = Effect.andThen(Queue.offer(notices, undefined), Fiber.join(publisher));
            const stamp = (notice: NoticePayload): NoticePayload => (origin === undefined ? notice : { ...notice, origin });
            yield* Effect.tryPromise({
              try: (signal) =>
                models.login(
                  providerId,
                  type,
                  authInteraction(interaction, run, signal, origin, (event) => {
                    Queue.offerUnsafe(notices, stamp(toNotice(event, provider.name)));
                  }),
                  { getDeviceId: () => deviceId(home) },
                ),
              catch: (error) => loginError(error, provider),
            }).pipe(
              Effect.ensuring(flush),
              // Failed or cancelled: a client showing the login (one that did not start it, say) closes it.
              Effect.onError((cause) =>
                events.publish(
                  Notice,
                  stamp({
                    level: "info",
                    source: "llm.pi-ai",
                    kind: "ended",
                    message: Cause.hasInterruptsOnly(cause) ? `${provider.name} login was cancelled` : `${provider.name} login failed`,
                  }),
                ),
              ),
            );
            // The credential is stored: the rest runs in the plugin's scope, so cancelling the login can no
            // longer report it cancelled. Its live catalog and `ModelsChanged` first, so clients that list
            // models on hearing of the login see all of them; every client learns of it, including one that
            // reloaded meanwhile.
            yield* Effect.forkIn(
              Effect.andThen(
                authChanged(providerId),
                events.publish(Notice, stamp({ level: "info", source: "llm.pi-ai", kind: "signed-in", message: `Logged in to ${provider.name}` })),
              ),
              scope,
            );
          }),

        logout: (providerId) =>
          Effect.tryPromise({
            try: (signal) => models.logout(providerId, { signal }),
            catch: (error) =>
              new LlmError({
                reason: "LoginFailed",
                provider: providerId,
                message: `Could not remove the ${providerId} credential: ${error instanceof Error ? error.message : String(error)}`,
                cause: error,
              }),
            // Signed out of a plan, the provider's own list returns.
          }).pipe(Effect.tap(() => authChanged(providerId))),

        addCustom: (spec) =>
          Effect.gen(function* () {
            const taken = new Set([...models.getProviders().map((provider) => provider.id), ...custom.keys()]);
            const entry = customEntry(spec, taken);
            if (entry === undefined) return yield* new LlmError({ reason: "InvalidProvider", message: `Unknown wire API "${spec.api}"` });
            yield* saveProviders(entry.id, { add: [entry] });
            return entry.id;
          }),

        removeCustom: (providerId) => Effect.andThen(customOf(providerId), saveProviders(providerId, { remove: [providerId] })),

        setLogo: (providerId, svg) =>
          Effect.flatMap(customOf(providerId), ({ logo: _logo, ...entry }) =>
            saveProviders(providerId, { add: [svg === undefined ? entry : { ...entry, logo: svg }] }),
          ),
      });
      for (const channel of yield* serveLlm(llm, events)) yield* plugin.add(Channels, channel);
      return { llm };
    },
  });
}

export default makeLlmPlugin();

export { credentialStore, runner } from "./auth.ts";
export { makeEventMapper } from "./convert.ts";
