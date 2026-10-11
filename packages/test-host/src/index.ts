import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { Agent } from "@lemma/agent";
import type { PromptOutcome } from "@lemma/agent";
import { compositionHistory } from "@lemma/composition";
import { definePlugin, Diagnostic, makeLoader, makeSpanCollector, ReloadError } from "@lemma/core";
import type { Plugin, PluginSource } from "@lemma/core";
import { emptyUsage, Llm, LlmError } from "@lemma/llm";
import type { AssistantMessage, LlmRequest, ModelInfo, StreamEvent, ToolCall } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { bundled } from "@lemma/host/bundled";
import { resolvePaths } from "@lemma/host/paths";
import { hostRuntime } from "@lemma/host/runtime";
import type { HostControlHandle } from "@lemma/host/runtime";

/*
 * `@lemma/test-host`: a plugin tested in real turns. The host's own agent, sessions, and tool registry run with the
 * plugins under test and a model that answers from a script, in a home of their own that `close` removes: what a turn
 * logs, what the model was sent, and what the tools did are the plugin's behavior, end to end, with no provider.
 */

/** One answer of the scripted model: its stream of events, as a provider's. */
export type Answer = readonly StreamEvent[];

const MODEL = "test/model";

const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "model",
  usage: { ...emptyUsage, input: 10, output: 5, totalTokens: 15 },
  stopReason,
  timestamp: Date.now(),
});

/** The model answers `text`, and stops. */
export const reply = (text: string): Answer => [
  { type: "start" },
  { type: "text-delta", index: 0, delta: text },
  { type: "done", message: message([{ type: "text", text }], "stop") },
];

/** A call of tool `name` with `args`, for `callTools`. */
export const call = (name: string, args: Record<string, unknown>, id = `call-${name}-${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args as ToolCall["arguments"],
});

/** The model calls these tools (and so the turn takes another step, to read their results). */
export const callTools = (...calls: readonly ToolCall[]): Answer => [
  { type: "start" },
  ...calls.flatMap((toolCall, index): StreamEvent[] => [
    { type: "toolcall-start", index, id: toolCall.id, name: toolCall.name },
    { type: "toolcall-end", index, toolCall },
  ]),
  { type: "done", message: message([...calls], "toolUse") },
];

/** The model call fails with `errorMessage`, as a provider's error does. */
export const fail = (errorMessage: string): Answer => [{ type: "start" }, { type: "error", message: { ...message([], "error"), errorMessage } }];

export interface TestHostOptions {
  /** The plugins under test: host halves, as a plugin file exports them. */
  readonly plugins: readonly Plugin[];
  /** What the model answers, call by call: a fixed answer, or one made from the request it was sent. */
  readonly model: readonly (Answer | ((request: LlmRequest) => Answer))[];
  /** Bundled plugins to run beside the agent, sessions, and tool registry, by id (`tools.read`). */
  readonly bundled?: readonly string[];
  /** Plugins' config, by id, as a row's `config`. */
  readonly configs?: Readonly<Record<string, unknown>>;
  /** The directory sessions start in; the test home's own by default. */
  readonly cwd?: string;
}

/** A turn run to its end: what it logged, what the model was sent, and how the prompt was taken. */
export interface TestTurn {
  readonly sessionId: string;
  readonly outcome: PromptOutcome;
  /** The session's log, every event. */
  readonly events: readonly SessionEvent[];
  /** The requests the model was sent in this turn, in order. */
  readonly requests: readonly LlmRequest[];
  /** The text the model answered with last. */
  readonly answer: string | undefined;
}

export interface TestHost {
  /** Sends `text` to a session (a new one unless given), and waits for the turn to end. */
  readonly prompt: (text: string, options?: { readonly sessionId?: string }) => Promise<TestTurn>;
  /** Runs `effect` with the composition's services (`Sessions`, `Agent`, a capability your plugin provides). */
  readonly run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;
  /** Every request the model was sent. */
  readonly requests: readonly LlmRequest[];
  /** Stops the plugins and removes the test home. */
  readonly close: () => Promise<void>;
}

/** A model that answers from `script`, in order, recording what it was sent. */
const scriptedModel = (script: TestHostOptions["model"], requests: LlmRequest[]): Plugin => {
  const left = [...script];
  const info: ModelInfo = {
    ref: MODEL,
    provider: "test",
    id: "model",
    name: "Test model",
    api: "test",
    reasoning: false,
    thinkingLevels: [],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 16_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return definePlugin({
    id: "test.model",
    provides: [Llm],
    layer: Layer.succeed(Llm, {
      providers: Effect.succeed([]),
      models: () => Effect.succeed([info]),
      model: (ref) => (ref === MODEL ? Effect.succeed(info) : Effect.fail(new LlmError({ reason: "UnknownModel", message: `The test model is ${MODEL}` }))),
      stream: (request) => {
        requests.push(request);
        const next = left.shift();
        if (next === undefined)
          return Stream.fail(new LlmError({ reason: "UnknownModel", message: `The model's script ran out at request ${requests.length}` }));
        return Stream.fromIterable(typeof next === "function" ? next(request) : next);
      },
      login: () => Effect.void,
      logout: () => Effect.void,
      addCustom: () => Effect.die("not in a test"),
      removeCustom: () => Effect.void,
      setLogo: () => Effect.void,
    }),
  });
};

/**
 * Starts the agent, sessions, and tool registry with `plugins` and a scripted model (`model`), in a test home.
 *
 *   const host = await testHost({ plugins: [todo], model: [callTools(call("todo", { action: "add", text: "x" })), reply("Added.")] });
 *   const turn = await host.prompt("add x");
 *   await host.close();
 */
export async function testHost(options: TestHostOptions): Promise<TestHost> {
  const home = await mkdtemp(join(tmpdir(), "lemma-test-"));
  const paths = resolvePaths({ env: { LEMMA_HOME: home }, cwd: options.cwd ?? home });
  const requests: LlmRequest[] = [];
  const wanted = new Set(["agent.loop", "sessions.files", "tools.registry", ...(options.bundled ?? [])]);
  const plugins = [...bundled.filter((plugin) => wanted.has(plugin.id)), scriptedModel(options.model, requests), ...options.plugins];
  const missing = [...wanted].filter((id) => !plugins.some((plugin) => plugin.id === id));
  if (missing.length > 0) throw new Error(`No bundled plugin ${missing.map((id) => `"${id}"`).join(", ")}`);
  const unavailable = <A>(what: string): Effect.Effect<A, ReloadError> =>
    Effect.fail(new ReloadError({ diagnostics: [new Diagnostic({ severity: "error", message: `${what} is not available in a test host` })] }));
  const control: HostControlHandle = {
    plugins: Effect.succeed([]),
    composition: Effect.succeed({ id: "test", plugins: plugins.map((plugin) => ({ id: plugin.id })) }),
    restart: () => unavailable("Restarting a plugin"),
    reload: unavailable("Reloading"),
    configure: () => unavailable("Configuring"),
    web: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
  };
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const source: PluginSource = {
    resolve: (id) => {
      const plugin = byId.get(id);
      return plugin === undefined ? Effect.fail(new Diagnostic({ severity: "error", message: `No plugin "${id}"` })) : Effect.succeed(plugin);
    },
  };
  const scope = Effect.runSync(Scope.make());
  const loader = await Effect.runPromise(
    Scope.provide(
      makeLoader({
        source,
        composition: {
          plugins: Object.fromEntries(
            plugins.map((plugin) => {
              const config = { ...(plugin.id === "agent.loop" ? { defaultModel: MODEL } : {}), ...(options.configs?.[plugin.id] as object | undefined) };
              return [plugin.id, Object.keys(config).length === 0 ? {} : { config }];
            }),
          ),
        },
        provide: hostRuntime({ paths, control, trace: { spans: makeSpanCollector(), changes: compositionHistory() } }),
      }),
      scope,
    ),
  ).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(home, { recursive: true, force: true });
    throw error;
  });
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(loader.core.run(effect as Effect.Effect<A, E, never>));
  return {
    requests,
    run,
    prompt: async (text, promptOptions) => {
      const before = requests.length;
      const sessionId = promptOptions?.sessionId ?? (await run(Effect.flatMap(Sessions, (sessions) => sessions.create()))).id;
      const outcome = await run(Effect.flatMap(Agent, (agent) => agent.prompt(sessionId, [{ type: "text", text }])));
      const events = await run(Effect.flatMap(Sessions, (sessions) => sessions.events(sessionId)));
      const last = [...events].reverse().find((event) => event.data.type === "message" && event.data.message.role === "assistant");
      const answer =
        last?.data.type === "message" && last.data.message.role === "assistant"
          ? last.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
          : undefined;
      return { sessionId, outcome, events, requests: requests.slice(before), answer };
    },
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(home, { recursive: true, force: true });
    },
  };
}
