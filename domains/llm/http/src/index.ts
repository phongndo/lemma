import { Cause, Effect, Exit, Fiber, Queue, Schedule, Schema, Semaphore, Stream } from "effect";
import type { Context } from "effect";
import { Events, Hooks, Registries, definePlugin } from "@lemma/core";
import type { Contribution, HandlerStep } from "@lemma/core";
import { Channels, creditOf, HostControl, inChainOrder, Interaction, InteractionError, InteractionOrigin, Notice, Paths } from "@lemma/contracts";
import type { NoticePayload } from "@lemma/contracts";
import { Credentials } from "@lemma/credentials";
import type { Credential } from "@lemma/credentials";
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
  ProviderSpec,
  serveLlm,
  streamThroughHook,
} from "@lemma/llm";
import type { AuthType, LlmRequest, ProviderHeaders, ProviderInfo, StreamEvent } from "@lemma/llm";
import { authSource, resolveAuth } from "./auth.ts";
import type { Env } from "./auth.ts";
import { devSource, planModels, planSource } from "./catalog.ts";
import { deviceId } from "./device.ts";
import { headerRecord } from "./http.ts";
import { identityHeaders } from "./identity.ts";
import { isWireApi, levelFor, modelRef, toModelInfo } from "./model.ts";
import type { Model } from "./model.ts";
import { Output } from "./output.ts";
import { builtin, builtinProviders, customEntry, customProvider, liveModels, selectProviders } from "./providers.ts";
import type { BuiltinProvider, CustomProvider, LoginContext, Provider } from "./providers.ts";
import { send } from "./request.ts";
import type { Auth } from "./wire.ts";

const Config = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Built-in provider ids to register; default all." }),
  exclude: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Built-in provider ids to leave out." }),
  providers: Schema.optional(Schema.Array(ProviderSpec)).annotate({
    description:
      "Providers on a wire API this plugin speaks: anthropic-messages, openai-responses, or openai-completions (OpenAI-compatible servers, proxies). Replace a built-in with the same id.",
  }),
  liveCatalogs: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Live model catalogs",
    description: "Read the models built-in providers serve now from models.dev, every hour, rather than keep this version's list.",
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

/** The response header a provider names its request id in, by the names providers use (not a CDN's trace id). */
const REQUEST_ID_HEADERS = ["request-id", "x-request-id", "openai-request-id", "x-amzn-requestid", "x-goog-request-id"];
const requestIdOf = (headers: Headers): string | undefined =>
  REQUEST_ID_HEADERS.map((name) => headers.get(name) ?? undefined).find((value) => value !== undefined);

type Headers_ = Readonly<Record<string, string | null>>;
/** The headers whose values differ between `before` and `after`, by name. */
const headerChanges = (before: Headers_, after: Headers_): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort();

/** Signed in with ChatGPT, a plan's usage is shared with its other apps: where to look when it runs out. */
const CHATGPT_USAGE = "https://chatgpt.com/settings/usage";

export interface Options {
  /** Replaces the built-in providers (tests serve their own). Filtered by `include` and `exclude`. */
  readonly providers?: () => readonly BuiltinProvider[];
  /** The environment keys are read from; default the process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How requests, sign-ins, and catalogs are fetched; default the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Runs an Effect as a promise: a typed failure rejects with the error itself, an interruption with the signal's reason. */
function runner(services: Context.Context<never>) {
  const run = Effect.runPromiseExitWith(services);
  return async <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal): Promise<A> => {
    const exit = await run(effect, { signal });
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === "Some") throw failure.value;
    throw Cause.squash(exit.cause);
  };
}

function loginError(error: unknown, provider: Provider): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof InteractionError && error.reason === "Dismissed") {
    return new LlmError({ reason: "Cancelled", provider: provider.id, message: `${provider.name} login was cancelled`, cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LlmError({ reason: "LoginFailed", provider: provider.id, message: `${provider.name} login failed: ${detail}`, cause: error });
}

export function makeLlmPlugin(options: Options = {}) {
  return definePlugin({
    id: "llm.http",
    implements: [LLM_CONTRACT],
    version: "0.1.0",
    config: Config,
    provides: { llm: Llm },
    requires: { credentials: Credentials, interaction: Interaction, host: HostControl, paths: Paths },
    setup: function* ({ credentials, interaction, host, paths }, plugin) {
      const config = plugin.config;
      const hooks = yield* Hooks;
      const events = yield* Events;
      const run = runner(yield* Effect.context<never>());
      const scope = yield* Effect.scope;
      const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
      const env: Env = (name) => (options.env ?? process.env)[name];
      /** Runs `effect` in the plugin's scope, its caller waiting: a caller stopped meanwhile leaves it to finish. */
      const detached = <A, E>(effect: Effect.Effect<A, E>) => Effect.flatMap(Effect.forkIn(effect, scope), Fiber.join);
      const authOf = (provider: Provider) => resolveAuth(provider, credentials, env, fetchImpl, detached);

      /** Every provider served, by id: the built-ins, the user's (one with a built-in's id replaces it), then those plugins add. */
      const providers = new Map<string, Provider>();
      const builtins = selectProviders((options.providers ?? builtinProviders)(), config).map(builtin);
      for (const provider of builtins) providers.set(provider.id, provider);
      /** The user's providers, by id; one on a protocol this plugin does not speak is left out, as it cannot be served. */
      const custom = new Map<string, CustomProvider>();
      for (const entry of config.providers ?? []) {
        if (isWireApi(entry.api)) custom.set(entry.id, { ...entry, api: entry.api });
        else yield* Effect.logWarning(`llm: the configured provider "${entry.id}" speaks "${entry.api}", which this plugin does not`);
      }
      for (const entry of custom.values()) providers.set(entry.id, customProvider(entry));
      /** Each built-in's catalog of the API's models, which a ChatGPT plan's list replaces while signed in. */
      const apiModels = new Map(builtins.map((provider) => [provider.id, provider.models]));

      /**
       * Saves a change to this plugin's own `providers` list, in the config file its config comes from. The change
       * restarts this plugin, so the host applies it once the work asking for it has ended (`ChangeReport`): a
       * client's call returns first.
       */
      const saveProviders = (provider: string, change: { readonly add?: readonly CustomProvider[]; readonly remove?: readonly string[] }) =>
        host.plugins
          .pipe(
            Effect.map((plugins) => plugins.find((info) => info.id === plugin.id)?.configScope),
            Effect.flatMap((configScope) =>
              host.configure(
                {
                  [plugin.id]: {
                    ...(change.add === undefined ? {} : { add: { providers: change.add } }),
                    ...(change.remove === undefined ? {} : { remove: { providers: change.remove } }),
                  },
                },
                configScope === "project" ? { scope: configScope } : undefined,
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

      const listed = () => [...providers.values()].flatMap((provider) => provider.models.map(modelRef)).join("\n");
      /** Clients hear that what `providers` and `models` list changed, and list them again. */
      const announce = events.publish(ModelsChanged, {});

      const dev = devSource(fetchImpl);
      const plan = planSource(fetchImpl);
      /** One refresh of a provider at a time, so a slow one cannot finish after a later one and put back what it replaced. */
      const refreshing = new Map(builtins.map((provider) => [provider.id, Semaphore.makeUnsafe(1)]));
      const signedInWithChatGPT = (provider: Provider) =>
        provider.id === "openai"
          ? credentials.read(provider.id).pipe(
              Effect.map((stored) => stored?.type === "oauth"),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false);
      /**
       * A built-in's catalog now: models.dev's list of it with `liveCatalogs` on (its own kept when models.dev is out of
       * reach or lists none), and OpenAI signed in with ChatGPT the plan's models, as the Codex CLI and app list them,
       * rather than the API's, many of which a plan does not serve.
       */
      const refreshOne = (provider: Provider, signal: AbortSignal) =>
        Effect.gen(function* () {
          // Signed out of a plan, the API's list returns at once, before anything waits on the network.
          if (!(yield* signedInWithChatGPT(provider))) provider.models = apiModels.get(provider.id) ?? provider.models;
          if (config.liveCatalogs) {
            const listing = (yield* Effect.promise(() => dev(signal)))?.[provider.id];
            const fresh = listing === undefined ? [] : liveModels(provider, listing);
            if (fresh.length > 0) apiModels.set(provider.id, fresh);
          }
          const api = apiModels.get(provider.id) ?? provider.models;
          if (!(yield* signedInWithChatGPT(provider))) {
            provider.models = api;
            return;
          }
          const auth = yield* authOf(provider).pipe(Effect.orElseSucceed(() => undefined));
          const offered = auth === undefined ? undefined : yield* Effect.promise(() => plan(auth.key, signal));
          // Out of reach, the plan's list it had stands; signed out meanwhile, the API's does.
          if (offered !== undefined && (yield* signedInWithChatGPT(provider))) provider.models = planModels(api, offered);
          else if (!(yield* signedInWithChatGPT(provider))) provider.models = api;
        });
      /** Updates the built-ins' catalogs (or `ids`'); failures keep the previous list. Whether the models listed changed. */
      const refresh = (ids?: readonly string[]) =>
        Effect.gen(function* () {
          const before = listed();
          const chosen = builtins.filter((provider) => (ids === undefined || ids.includes(provider.id)) && providers.get(provider.id) === provider);
          yield* Effect.forEach(
            chosen,
            (provider) =>
              refreshing
                .get(provider.id)!
                .withPermits(1)(Effect.scoped(Effect.flatMap(Effect.abortSignal, (signal) => refreshOne(provider, signal))))
                .pipe(Effect.catchCause((cause) => Effect.logDebug(`llm: model refresh failed for ${provider.id}: ${Cause.pretty(cause)}`))),
            { concurrency: "unbounded" },
          );
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
            const leftOut = !isWireApi(api)
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
          for (const id of added.keys()) if (!next.has(id)) providers.delete(id);
          for (const [id, contribution] of next) {
            if (added.get(id)?.item !== contribution.item)
              providers.set(id, customProvider({ ...contribution.item, api: contribution.item.api as CustomProvider["api"] }));
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
      const findModel = (ref: string): Model | undefined => {
        const parsed = parseModelRef(ref);
        return parsed === undefined ? undefined : providers.get(parsed.provider)?.models.find((model) => model.id === parsed.model);
      };

      const terminal = (request: LlmRequest) =>
        Effect.gen(function* () {
          const model = findModel(request.model);
          const provider = model === undefined ? undefined : providers.get(model.provider);
          if (model === undefined || provider === undefined) return yield* Effect.fail(unknownModel(request.model));
          // Plugins may add, change, or drop headers, over what would be sent (the model's own, the provider's, and
          // Lemma's User-Agent); who changed which is told back with the answer, values never.
          const steps: HandlerStep<ProviderHeaders, Headers_>[] = [];
          const headers = yield* hooks
            .invoke(
              LlmProviderHeadersHook,
              { request, provider: model.provider, headers: { ...model.headers, ...provider.headers?.(request.sessionId), ...identityHeaders(model) } },
              (input) => Effect.succeed(input.headers),
              { onStep: (step) => void steps.push(step) },
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
          const level = levelFor(model, request.thinking);
          return Stream.callback<StreamEvent>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const controller = new AbortController();
                let closed = false;
                /** The provider's answer, held until `start` has gone out: a stream begins with `start`. */
                let answer: StreamEvent | undefined;
                let told = false;
                let started = false;
                let stalled = false;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const idleMs = config.streamTimeout * 1000;
                const emit = (out: StreamEvent[]) => {
                  if (closed || out.length === 0) return;
                  arm();
                  // A request that failed before the provider answered (refused before its body, or never sent) still
                  // says who shaped its headers.
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
                const output = new Output(model, emit);
                const close = () => {
                  clearTimeout(timer);
                  if (!closed) Queue.endUnsafe(queue);
                  closed = true;
                };
                // A response that sends nothing for `streamTimeout` ends at once as a transient failure, and the
                // request is aborted: a half-open connection would otherwise hold the turn forever.
                function arm() {
                  if (idleMs <= 0 || closed) return;
                  clearTimeout(timer);
                  timer = setTimeout(() => {
                    stalled = true;
                    output.fail(new Error(`The model sent nothing for ${config.streamTimeout} seconds; the request was cut off as stalled`), {
                      kind: "transient",
                    });
                    close();
                    controller.abort();
                  }, idleMs);
                }
                let auth: Auth | undefined;
                void (async () => {
                  arm();
                  try {
                    auth = await run(authOf(provider), controller.signal);
                    if (auth === undefined) {
                      const message = `${provider.name} is not authenticated. Run /login ${provider.id} or set its API key environment variable.`;
                      return output.fail(new Error(message), { kind: "fatal" });
                    }
                    await send({ model, request, level, auth, cacheRetention: config.cacheRetention }, output, {
                      fetch: fetchImpl,
                      headers,
                      signal: controller.signal,
                      // Before its body: told to the caller, logged with the answer, and published.
                      answered: (response) => {
                        const requestId = requestIdOf(response.headers);
                        answer = {
                          type: "provider",
                          status: response.status,
                          ...(requestId === undefined ? {} : { requestId }),
                          ...(handlers.length === 0 ? {} : { credit: { handlers } }),
                        };
                        Effect.runFork(events.publish(LlmProviderResponse, { ...where, status: response.status, headers: headerRecord(response.headers) }));
                      },
                      raw: config.providerEvents ? (data) => void Effect.runFork(events.publish(LlmProviderStreamEvent, { ...where, data })) : () => {},
                      alive: arm,
                    });
                    output.finish();
                  } catch (error) {
                    const aborted = controller.signal.aborted && !stalled;
                    const message = error instanceof Error ? error.message : String(error);
                    output.fail(
                      auth?.oauth === true && message.includes("usage_limit_exceeded")
                        ? new Error(`${message}\nCheck your ChatGPT usage: ${CHATGPT_USAGE}`, { cause: error })
                        : error,
                      undefined,
                      aborted,
                    );
                  } finally {
                    close();
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

      const configured = (provider: Provider) =>
        credentials.read(provider.id).pipe(
          Effect.orElseSucceed((): Credential | undefined => undefined),
          Effect.map((stored) => authSource(provider, stored, env)),
        );
      const toProviderInfo = (provider: Provider, source: string | undefined): ProviderInfo => {
        const entry = custom.get(provider.id);
        const from = added.get(provider.id);
        // The user's logo for their own provider; a plugin's provider brings its own.
        const logo = entry?.logo ?? from?.item.logo;
        return {
          id: provider.id,
          name: provider.name,
          auth: [
            { type: "api_key" as const, name: provider.apiKey.name, interactive: true },
            ...(provider.oauth === undefined ? [] : [{ type: "oauth" as const, name: provider.oauth.name, interactive: true }]),
          ],
          configured: source !== undefined,
          ...(source === undefined ? {} : { source }),
          ...(entry === undefined ? {} : { custom: true }),
          ...(logo === undefined ? {} : { logo }),
          ...(from === undefined ? {} : { from: from.pluginId }),
        };
      };

      const notice = (origin: string | undefined, payload: Omit<NoticePayload, "level" | "source" | "origin">) =>
        events.publish(Notice, { level: "info", source: plugin.id, ...payload, ...(origin === undefined ? {} : { origin }) });

      const llm = Llm.of({
        // Read when asked: the providers plugins add come and go while it runs.
        providers: Effect.suspend(() =>
          Effect.forEach([...providers.values()], (provider) => Effect.map(configured(provider), (source) => toProviderInfo(provider, source)), {
            concurrency: "unbounded",
          }),
        ),

        models: (query) =>
          Effect.suspend(() =>
            Effect.forEach(
              [...providers.values()],
              (provider) =>
                query?.available === true
                  ? Effect.map(configured(provider), (source) => (source === undefined ? [] : provider.models))
                  : Effect.succeed(provider.models),
              { concurrency: "unbounded" },
            ),
          ).pipe(Effect.map((lists) => lists.flat().map(toModelInfo))),

        model: (ref) =>
          Effect.suspend(() => {
            const model = findModel(ref);
            return model === undefined ? Effect.fail(unknownModel(ref)) : Effect.succeed(toModelInfo(model));
          }),

        stream: (request) => streamThroughHook(hooks, request, terminal),

        // Classifiers and image models are other protocols than this plugin speaks: it serves none.
        classifiers: () => Effect.succeed([]),
        classify: (ref) => Effect.fail(unknownModel(ref)),
        imageModels: () => Effect.succeed([]),
        generateImages: (ref) => Effect.fail(unknownModel(ref)),

        login: (providerId: string, type: AuthType) =>
          Effect.gen(function* () {
            const provider = providers.get(providerId);
            if (provider === undefined) {
              return yield* Effect.fail(new LlmError({ reason: "UnknownProvider", provider: providerId, message: `Unknown provider: ${providerId}` }));
            }
            const oauth = provider.oauth;
            if (type === "oauth" && oauth === undefined) {
              return yield* Effect.fail(
                new LlmError({ reason: "LoginFailed", provider: providerId, message: `${provider.name} does not support OAuth login` }),
              );
            }
            // Its questions and its link or code share the origin, so a client shows them together.
            const origin = yield* InteractionOrigin;
            const context: LoginContext = {
              notify: (payload) => notice(origin, payload),
              ask: (title, askOptions) => interaction.ask(title, askOptions),
              deviceId: () => deviceId(paths.home),
              fetch: fetchImpl,
            };
            const credential: Effect.Effect<Credential, unknown> =
              oauth !== undefined && type === "oauth"
                ? (oauth.login(context) as Effect.Effect<Credential, unknown>)
                : interaction
                    .ask(`Enter the ${provider.name} API key`, { secret: true })
                    .pipe(
                      Effect.flatMap((key) =>
                        key.trim() === "" ? Effect.fail(new Error("no key was entered")) : Effect.succeed<Credential>({ type: "api_key", key: key.trim() }),
                      ),
                    );
            yield* credential.pipe(
              Effect.flatMap((stored) => credentials.modify(providerId, () => stored)),
              Effect.mapError((error) => loginError(error, provider)),
              // Failed or cancelled: a client showing the login (one that did not start it, say) closes it.
              Effect.onError((cause) =>
                notice(origin, {
                  kind: "ended",
                  message: Cause.hasInterruptsOnly(cause) ? `${provider.name} login was cancelled` : `${provider.name} login failed`,
                }),
              ),
            );
            // The credential is stored: the rest runs in the plugin's scope, so cancelling the login can no longer
            // report it cancelled. Its catalog and `ModelsChanged` first, so clients that list models on hearing of the
            // login see all of them; every client learns of it, including one that reloaded meanwhile.
            yield* Effect.forkIn(
              Effect.andThen(authChanged(providerId), notice(origin, { kind: "signed-in", message: `Logged in to ${provider.name}` })),
              scope,
            );
          }),

        logout: (providerId) =>
          credentials.remove(providerId).pipe(
            Effect.mapError(
              (error) =>
                new LlmError({
                  reason: "LoginFailed",
                  provider: providerId,
                  message: `Could not remove the ${providerId} credential: ${error.message}`,
                  cause: error,
                }),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                // Signed out of a plan, the API's list returns at once; the refresh that follows brings it up to date.
                const provider = providers.get(providerId);
                const api = apiModels.get(providerId);
                if (provider !== undefined && api !== undefined) provider.models = api;
              }),
            ),
            Effect.tap(() => authChanged(providerId)),
          ),

        addCustom: (spec) =>
          Effect.gen(function* () {
            const taken = new Set([...providers.keys(), ...custom.keys()]);
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

export type { BuiltinProvider, LoginContext, OAuthCredential, OAuthMethod } from "./providers.ts";
