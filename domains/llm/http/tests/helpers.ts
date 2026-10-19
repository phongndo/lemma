import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Semaphore } from "effect";
import { PluginContext, awaitable, definePlugin, makeCore } from "@lemma/core";
import type { Events, Plugin } from "@lemma/core";
import { HostControl, Interaction, InteractionError, InteractionOrigin, Notice, Paths } from "@lemma/contracts";
import type { ConfigScope, NoticePayload, PluginChange } from "@lemma/contracts";
import { Credentials } from "@lemma/credentials";
import type { Credential } from "@lemma/credentials";
import type { Llm } from "@lemma/llm";
import { makeLlmPlugin } from "../src/index.ts";
import type { BuiltinProvider } from "../src/index.ts";
import type { CatalogModel } from "../src/model.ts";

export function fakeCredentials(initial: Record<string, Credential> = {}) {
  const store = new Map<string, Credential>(Object.entries(initial));
  const lock = Semaphore.makeUnsafe(1);
  const service: typeof Credentials.Service = {
    read: (provider) => Effect.sync(() => store.get(provider)),
    list: Effect.sync(() => [...store].map(([provider, credential]) => ({ provider, type: credential.type }))),
    modify: (provider, update) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* awaitable(() => update(store.get(provider)));
          if (next !== undefined) store.set(provider, next);
          return store.get(provider);
        }),
      ),
    remove: (provider) => Effect.sync(() => void store.delete(provider)),
  };
  const plugin = definePlugin({ id: "credentials", provides: [Credentials], layer: Layer.succeed(Credentials, service) });
  return { store, service, plugin };
}

type Question =
  | { readonly type: "ask"; readonly title: string; readonly secret?: boolean; readonly placeholder?: string; readonly kind?: string }
  | { readonly type: "select"; readonly title: string; readonly options: readonly string[] };

/** Answers questions with `answer`; every question is recorded, with the origin it was asked under. */
export function fakeInteraction(answer: (question: Question) => Effect.Effect<string, InteractionError>) {
  const asked: Question[] = [];
  const origins: (string | undefined)[] = [];
  const respond = (question: Question) =>
    Effect.flatMap(InteractionOrigin, (origin) => {
      asked.push(question);
      origins.push(origin);
      return answer(question);
    });
  const service: typeof Interaction.Service = {
    confirm: () => Effect.succeed(true),
    ask: (title, options) => respond({ type: "ask", title, ...options }),
    select: (title, options) => respond({ type: "select", title, options: options.map((option) => option.value) }) as Effect.Effect<never, InteractionError>,
    form: (title) => Effect.fail(new InteractionError({ reason: "Unavailable", message: `No form is answered here: "${title}"` })),
  };
  const plugin = definePlugin({ id: "interaction", provides: [Interaction], layer: Layer.succeed(Interaction, service) });
  return { asked, origins, plugin };
}

/** Records every `Notice` through a plugin observer, so no publish races a late subscriber. */
export function noticeRecorder() {
  const notices: NoticePayload[] = [];
  const plugin = definePlugin({
    id: "notices",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const context = yield* PluginContext;
        yield* context.observe(Notice, (notice) => Effect.sync(() => void notices.push(notice)), { overflow: "suspend" });
      }),
    ),
  });
  return { notices, plugin };
}

/**
 * A host that records the config changes plugins ask it to save; `configure` succeeds as a deferred change would.
 * Its composition is what a client's connect probe (`Host.Info`) reads.
 */
export function fakeHost(options: { readonly configScope?: ConfigScope } = {}) {
  const saved: Record<string, PluginChange>[] = [];
  const scopes: (ConfigScope | undefined)[] = [];
  const unused = () => Effect.die("not used by the llm plugin");
  const service = {
    runtime: [HostControl.key, Paths.key],
    process: { pid: process.pid, startedAt: 0 },
    plugins: Effect.succeed([{ id: "llm.http", ...(options.configScope === undefined ? {} : { configScope: options.configScope }) }]),
    composition: Effect.succeed({ id: "test", plugins: [] }),
    restart: unused,
    reload: unused(),
    configure: (plugins: Record<string, PluginChange>, configure?: { readonly scope?: ConfigScope }) =>
      Effect.sync(() => {
        saved.push(plugins);
        scopes.push(configure?.scope);
        return { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [], deferred: true };
      }),
    web: unused(),
  } as unknown as typeof HostControl.Service;
  // A home of its own, as the host's: the llm plugin keeps the installation's device ID there.
  const home = mkdtempSync(join(tmpdir(), "lemma-llm-home-"));
  const paths = { home, userConfig: join(home, "config.jsonc"), projectConfig: join(home, "project.jsonc"), cwd: home };
  const plugin = definePlugin({
    id: "host",
    provides: [HostControl, Paths],
    layer: Layer.merge(Layer.succeed(HostControl, service), Layer.succeed(Paths, paths)),
  });
  return { saved, scopes, home, plugin };
}

/** Runs `body` against `plugins`, adding a `fakeHost` when none of them provides `HostControl`. */
export const runWith = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Llm | Events>, configs: Record<string, unknown> = {}): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hosted = plugins.some((plugin) => plugin.provides.some((tag) => tag.key === HostControl.key));
        const core = yield* makeCore(hosted ? plugins : [...plugins, fakeHost().plugin], { configs });
        return yield* core.run(body) as Effect.Effect<A, E | unknown>;
      }),
    ) as Effect.Effect<A>,
  );

/** What a scripted provider was sent: the URL, the headers, and the body. */
export interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

/** A server-sent event stream of `events`, each a `data:` line of JSON (`[DONE]` as it is), with `event:` names where given. */
export function sseBody(events: readonly (unknown | { readonly event: string; readonly data: unknown })[]): string {
  return events
    .map((event) => {
      if (typeof event === "object" && event !== null && "event" in event && "data" in event) {
        const named = event as { event: string; data: unknown };
        return `event: ${named.event}\ndata: ${JSON.stringify(named.data)}\n\n`;
      }
      return `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
    })
    .join("");
}

export const sseResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init, headers: { "content-type": "text/event-stream", ...(init.headers as Record<string, string> | undefined) } });

/**
 * A `fetch` that answers each model request with `answer` (what it was sent) and keeps every request it was sent;
 * anything else (models.dev, a provider's list) fails, as offline.
 */
export function scriptedFetch(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method !== "POST") throw new Error("offline in tests");
    const request: Sent = {
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      signal: init.signal ?? undefined,
    };
    sent.push(request);
    return answer(request);
  };
  return { sent, fetch: fetchImpl };
}

/** Keeps live catalogs off the network: every fetch fails, so providers keep the committed catalog. */
export const offline: typeof fetch = () => Promise.reject(new Error("offline in tests"));

/** A chat model of a test provider's catalog. */
export const catalogModel = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  api: "openai-completions",
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 8_000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  ...extra,
});

/** A provider served at `https://faux.test`, keyed by `FAUX_KEY`, with a plain model and a thinking one. */
export const faux = (extra: Partial<BuiltinProvider> = {}): BuiltinProvider => ({
  id: "faux",
  name: "Faux",
  apis: { "openai-completions": "https://faux.test/v1", "openai-responses": "https://faux.test/v1", "anthropic-messages": "https://faux.test" },
  env: ["FAUX_KEY"],
  models: [
    catalogModel("plain"),
    catalogModel("thinker", { reasoning: true, thinking: { kind: "effort", levels: ["off", "low", "medium", "high"], values: { off: "none" } } }),
  ],
  ...extra,
});

/** One Chat Completions chunk: a delta, and a finish reason when given. */
export const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: "c1",
  object: "chat.completion.chunk",
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

/** A Chat Completions answer of `text`, then a call of each tool given. */
export function completion(text: string, calls: readonly { readonly id: string; readonly name: string; readonly arguments: unknown }[] = []): string {
  return sseBody([
    chunk({ role: "assistant", content: text }),
    ...calls.map((call, index) =>
      chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }),
    ),
    chunk({}, calls.length > 0 ? "tool_calls" : "stop"),
    chunk({}, null, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    "[DONE]",
  ]);
}

/** The llm plugin with `providers`, a key for each in the environment unless `env` says otherwise, and `fetch`. */
export function setup(options: { readonly providers?: readonly BuiltinProvider[]; readonly env?: Record<string, string>; readonly fetch?: typeof fetch } = {}) {
  const credentials = fakeCredentials();
  const interaction = fakeInteraction(() => Effect.succeed("sk-test"));
  const llm = makeLlmPlugin({ fetch: options.fetch ?? offline, providers: () => options.providers ?? [faux()], env: options.env ?? { FAUX_KEY: "sk-faux" } });
  return { credentials, interaction, plugins: [credentials.plugin, interaction.plugin, llm] as const };
}
