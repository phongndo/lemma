import { Effect, Schedule, Schema, Stream } from "effect";
// pi-ai's modules, not its index: the index loads TypeBox (~670 modules), which only a provider's requests use.
import { createModels } from "@earendil-works/pi-ai/models";
import type { AuthCheck, AuthContext, ModelTypeMap, Provider } from "@earendil-works/pi-ai";
import { setOAuthPageRenderer } from "@earendil-works/pi-ai/utils/oauth-page";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Events, Hooks, Registries, definePlugin } from "@lemma/core";
import type { Contribution } from "@lemma/core";
import { Channels, errorMessage, HostControl, Notice, Paths } from "@lemma/contracts";
import { Credentials } from "@lemma/credentials";
import { Llm, LLM_CONTRACT, LlmError, makeSignIns, ModelsChanged, parseModelRef, Providers, serveLlm, streamThroughHook } from "@lemma/llm";
import type { AuthType, LlmRequest, LoginOptions, ProviderInfo, ProviderSpec } from "@lemma/llm";
import { accountOf } from "./account.ts";
import type { Account } from "./account.ts";
import { credentialStore, runner, signInInteraction } from "./auth.ts";
import { toClassifierContext, toClassifierInfo, toClassifierResult, toImageModelInfo, toImagesContext, toImagesResult, toModelInfo } from "./convert.ts";
import { networkSources, planSource, withLiveCatalog, withPlanCatalog } from "./catalog.ts";
import { deviceId } from "./device.ts";
import { identityHeaders } from "./identity.ts";
import { keyCheck } from "./keycheck.ts";
import { signInPage } from "./page.ts";
import {
  CustomProvider,
  customEntry,
  customProvider,
  knownApi,
  selectProviders,
  watchRefresh,
  withBuiltinIdentity,
  withoutAnthropicOAuth,
} from "./providers.ts";
import { streamResponse } from "./stream.ts";

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
});
type Config = typeof Config.Type;

interface Options {
  /** Replaces pi-ai's built-in provider list (tests register the faux provider here). Filtered by `include`/`exclude`. */
  readonly providers?: () => readonly Provider[];
  /** Environment used for auth resolution; default `process.env` and the filesystem. */
  readonly authContext?: AuthContext;
  /** How live catalogs are fetched; default the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * `custom`: the user's entry for a provider they added; `from`: the plugin that added it to `Providers`; `account`: who
 * its sign-in is; `expired`: why its sign-in stopped working.
 */
function toProviderInfo(
  provider: Provider,
  check: AuthCheck | undefined,
  custom: CustomProvider | undefined,
  from: Contribution<ProviderSpec> | undefined,
  account: Account,
  expired: string | undefined,
): ProviderInfo {
  // The user's logo for their own provider; a plugin's provider brings its own.
  const logo = custom?.logo ?? from?.item.logo;
  const { apiKey, oauth } = provider.auth;
  return {
    id: provider.id,
    name: provider.name,
    auth: [
      ...(apiKey === undefined ? [] : [{ type: "api_key" as const, name: apiKey.name, interactive: apiKey.login !== undefined }]),
      ...(oauth === undefined
        ? []
        : [
            {
              type: "oauth" as const,
              name: oauth.loginLabel ?? oauth.name,
              interactive: true,
              ...(oauth.isSubscription === true ? { subscription: true } : {}),
            },
          ]),
    ],
    configured: check !== undefined,
    ...(check?.source === undefined ? {} : { source: check.source }),
    // Who it is signed in as, while the sign-in is what requests use.
    ...(check?.type === "oauth" ? account : {}),
    ...(check?.type === "oauth" && expired !== undefined ? { expired } : {}),
    ...(custom === undefined ? {} : { custom: true }),
    ...(logo === undefined ? {} : { logo }),
    ...(from === undefined ? {} : { from: from.pluginId }),
  };
}

/**
 * pi-ai's page renderer is process-wide: the latest running plugin's is the one shown, and one stopping (as a reload
 * replaces it) puts back the one before it.
 */
const pages = (() => {
  const stack: ((page: Parameters<typeof signInPage>[0]) => string)[] = [];
  const apply = () => setOAuthPageRenderer(stack.at(-1));
  return {
    push: (render: (typeof stack)[number]) => {
      stack.push(render);
      apply();
    },
    remove: (render: (typeof stack)[number]) => {
      const at = stack.lastIndexOf(render);
      if (at >= 0) stack.splice(at, 1);
      apply();
    },
  };
})();

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function loginError(error: unknown, provider: Provider): LlmError {
  if (isAbort(error)) {
    return new LlmError({ reason: "Cancelled", provider: provider.id, message: `${provider.name} login was cancelled`, cause: error });
  }
  const detail = errorMessage(error);
  return new LlmError({ reason: "LoginFailed", provider: provider.id, message: `${provider.name} login failed: ${detail}`, cause: error });
}

export function makeLlmPlugin(options: Options = {}) {
  return definePlugin({
    id: "llm.pi-ai",
    implements: [LLM_CONTRACT],
    version: "0.1.0",
    config: Config,
    provides: { llm: Llm },
    requires: { credentials: Credentials, host: HostControl, paths: Paths },
    setup: function* ({ credentials, host, paths }, plugin) {
      const config = plugin.config;
      const hooks = yield* Hooks;
      const events = yield* Events;
      const { home } = paths;
      const run = runner(yield* Effect.context<never>());
      const scope = yield* Effect.scope;
      const fetchImpl = options.fetch ?? fetch;
      const signIns = yield* makeSignIns();
      /** Where each running sign-in's page offers to go back to, by provider. */
      const returnTo = new Map<string, string>();
      /** The sign-ins whose refresh the provider refused, by provider: why. A new sign-in, or a refresh that works, clears it. */
      const expired = new Map<string, string>();
      /**
       * Who each sign-in is, by provider: from its login, else read once when providers are listed. A refresh keeps the
       * account; a login replaces it and a logout forgets it.
       */
      const accounts = new Map<string, Account>();

      const models = createModels({
        credentials: credentialStore(credentials, run),
        ...(options.authContext === undefined ? {} : { authContext: options.authContext }),
      });
      // A missing model may be described already by another built-in provider's catalog.
      const siblings = () => builtins.flatMap((provider) => provider.getModels());
      const sources = networkSources(fetchImpl, siblings);
      const plan = planSource(fetchImpl);
      // OpenAI signed in with ChatGPT lists the plan's models, as the Codex CLI and app do, not the API's.
      const live = (provider: Provider) => {
        const caught = withLiveCatalog(provider, sources);
        return provider.id === "openai" ? withPlanCatalog(caught, plan) : caught;
      };
      // Live catalogs use the upstream id; filters and every public model ref use Lemma's stable identity.
      const builtins = selectProviders(
        (options.providers ?? builtinProviders)().map((provider) => withBuiltinIdentity(config.liveCatalogs ? live(provider) : provider)),
        config,
      ).map((provider) => watchRefresh(withoutAnthropicOAuth(provider), (id, why) => reportRefresh(id, why)));
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

      // Pooled Codex websockets keep the event loop alive until released. Only pi-ai's index exports the release, so it
      // is imported as the plugin stops rather than with it.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          import("@earendil-works/pi-ai")
            .then(({ cleanupSessionResources }) => cleanupSessionResources())
            .catch(() => {
              // Best effort: a socket that fails to close cannot hold the plugin open.
            }),
        ),
      );

      const listed = () =>
        models
          .getProviders()
          .flatMap((provider) => provider.getModels().map((model) => `${provider.id}/${model.id}`))
          .join("\n");
      /** Clients hear that what `providers` and `models` list changed, and list them again. */
      const announce = events.publish(ModelsChanged, {});
      /** A refresh refused (`why`) or working again: told when it changes, as the provider's row says so. */
      function reportRefresh(id: string, why: string | undefined) {
        if (expired.get(id) === why) return;
        if (why === undefined) expired.delete(id);
        else expired.set(id, why);
        Effect.runFork(announce);
      }

      // The page a sign-in's browser comes back to is Lemma's, about the sign-in showing its page now (the latest, when
      // two do), offering the way back its client named.
      const page = (shown: Parameters<typeof signInPage>[0]) => {
        const waiting = signIns
          .current()
          .filter((signIn) => signIn.ended === undefined && signIn.step.type !== "code")
          .at(-1);
        const provider = waiting === undefined ? undefined : models.getProvider(waiting.provider);
        return signInPage(shown, { provider: provider?.name, returnTo: waiting === undefined ? undefined : returnTo.get(waiting.provider) });
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => pages.push(page)),
        () => Effect.sync(() => pages.remove(page)),
      );
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

      /**
       * A list of one type of model, each as `info`: every one known, or (`available`) those of the providers set up to
       * use. A provider that fails to say lists none.
       */
      const listOfType =
        <M, I>(all: () => readonly M[], available: (provider: string, signal: AbortSignal) => Promise<readonly M[]>, info: (model: M) => I) =>
        (query?: { readonly available?: boolean }) =>
          query?.available === true
            ? Effect.forEach(
                models.getProviders(),
                (provider) => Effect.tryPromise((signal) => available(provider.id, signal)).pipe(Effect.orElseSucceed(() => [])),
                { concurrency: "unbounded" },
              ).pipe(Effect.map((lists) => lists.flat().map(info)))
            : Effect.sync(() => all().map(info));

      /**
       * Runs the model of `type` that `ref` names. pi-ai's `classify` and `generateImages` never reject: a provider's
       * failure, or missing auth, is the result's error.
       */
      const runOfType = <T extends "classifier" | "image", R>(
        type: T,
        ref: string,
        run: (model: ModelTypeMap[T], options: { readonly signal: AbortSignal; readonly headers?: Record<string, string> }) => Promise<R>,
      ) =>
        Effect.suspend(() => {
          const parsed = parseModelRef(ref);
          const model = parsed === undefined ? undefined : models.getModelOfType(type, parsed.provider, parsed.model);
          if (model === undefined) return Effect.fail(unknownModel(ref));
          const headers = identityHeaders(model);
          return Effect.promise((signal) => run(model, { signal, ...(headers === undefined ? {} : { headers }) }));
        });

      const terminal = (request: LlmRequest) =>
        Effect.suspend(() => {
          const model = findModel(request.model);
          const provider = model === undefined ? undefined : models.getProvider(model.provider);
          return model === undefined || provider === undefined
            ? Effect.fail(unknownModel(request.model))
            : Effect.succeed(streamResponse(models, model, provider, request, config));
        });

      const llm = Llm.of({
        // Read when asked: the providers plugins add come and go while it runs.
        providers: Effect.suspend(() =>
          Effect.forEach(
            models.getProviders(),
            (provider) =>
              Effect.tryPromise((signal) => models.checkAuth(provider.id, { signal })).pipe(
                Effect.orElseSucceed(() => undefined),
                // Who a sign-in is: kept from its login, else read from its credential once, beside the other checks.
                Effect.flatMap((check) =>
                  check?.type !== "oauth" || accounts.has(provider.id)
                    ? Effect.succeed(check)
                    : Effect.as(
                        Effect.tap(
                          Effect.orElseSucceed(credentials.read(provider.id), () => undefined),
                          (credential) => Effect.sync(() => void accounts.set(provider.id, accountOf(credential))),
                        ),
                        check,
                      ),
                ),
                Effect.map((check) =>
                  toProviderInfo(provider, check, custom.get(provider.id), added.get(provider.id), accounts.get(provider.id) ?? {}, expired.get(provider.id)),
                ),
              ),
            { concurrency: "unbounded" },
          ),
        ),

        models: listOfType(
          () => models.getModels(),
          (provider, signal) => models.getAvailable(provider, { signal }),
          toModelInfo,
        ),

        model: (ref) => {
          const model = findModel(ref);
          return model === undefined ? Effect.fail(unknownModel(ref)) : Effect.succeed(toModelInfo(model));
        },

        stream: (request) => streamThroughHook(hooks, request, terminal),

        classifiers: listOfType(
          () => models.getModelsOfType("classifier"),
          (provider, signal) => models.getAvailableOfType("classifier", provider, { signal }),
          toClassifierInfo,
        ),

        classify: (ref, context) =>
          runOfType("classifier", ref, (model, options) => models.classify(model, toClassifierContext(context), options)).pipe(Effect.map(toClassifierResult)),

        imageModels: listOfType(
          () => models.getModelsOfType("image"),
          (provider, signal) => models.getAvailableOfType("image", provider, { signal }),
          toImageModelInfo,
        ),

        generateImages: (ref, context) =>
          runOfType("image", ref, (model, options) => models.generateImages(model, toImagesContext(context), options)).pipe(Effect.map(toImagesResult)),

        login: (providerId: string, type: AuthType, login: LoginOptions = {}) =>
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
            const check = type === "api_key" ? keyCheck(provider, fetchImpl) : undefined;
            const { who } = yield* signIns
              .run(
                providerId,
                type,
                (signIn) =>
                  Effect.suspend(() => {
                    if (login.returnTo === undefined) returnTo.delete(providerId);
                    else returnTo.set(providerId, login.returnTo);
                    let found: (() => { readonly models?: number } | undefined) | undefined;
                    return Effect.tryPromise({
                      try: (signal) => {
                        const flow = signInInteraction(signIn, run, signal, { browser: login.browser, keys: type === "api_key", check });
                        found = flow.found;
                        // Providers see Lemma, at sign-in too: OpenAI names the agent it lets in.
                        return models.login(providerId, type, flow.interaction, { getDeviceId: () => deviceId(home), agentName: "Lemma" });
                      },
                      catch: (error) => loginError(error, provider),
                    }).pipe(Effect.map((stored) => ({ who: accountOf(stored), found: found?.() })));
                  }),
                ({ who, found }) => {
                  if (who.account !== undefined) return `Signed in as ${who.account}`;
                  if (found?.models !== undefined) return `The key works: ${found.models} model${found.models === 1 ? "" : "s"} listed`;
                  return found === undefined ? undefined : "The key works";
                },
              )
              .pipe(Effect.ensuring(Effect.sync(() => returnTo.delete(providerId))));
            // Signed in afresh: whatever expired is gone, and who it is may have changed.
            expired.delete(providerId);
            accounts.set(providerId, who);
            // The credential is stored: the rest runs in the plugin's scope, so cancelling the login can no
            // longer report it cancelled. Its live catalog and `ModelsChanged` first, so clients that list
            // models on hearing of the login see all of them; every client learns of it, including one that
            // reloaded meanwhile.
            yield* Effect.forkIn(
              Effect.andThen(
                authChanged(providerId),
                events.publish(Notice, {
                  level: "info",
                  source: "llm.pi-ai",
                  message: `Signed in to ${provider.name}${who.account === undefined ? "" : ` as ${who.account}`}`,
                }),
              ),
              scope,
            );
          }),

        signIns: signIns.list,

        answerSignIn: signIns.answer,

        // Signed out of a plan, the provider's own list returns; who it was, and why it expired, go with it.
        logout: (providerId) =>
          Effect.tryPromise({
            try: (signal) => models.logout(providerId, { signal }),
            catch: (error) =>
              new LlmError({
                reason: "LoginFailed",
                provider: providerId,
                message: `Could not remove the ${providerId} credential: ${errorMessage(error)}`,
                cause: error,
              }),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                accounts.delete(providerId);
                expired.delete(providerId);
              }),
            ),
            Effect.tap(() => authChanged(providerId)),
          ),

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
