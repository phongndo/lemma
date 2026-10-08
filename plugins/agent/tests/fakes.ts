import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Deferred, Duration, Effect, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Events, Plugin } from "@lemma/core";
import { AssistantDelta, emptyUsage, HostControl, Llm, LlmError, Sessions, ToolResult, Tools, TurnEnded, TurnStarted } from "@lemma/contracts";
import type { Agent, AssistantMessage, EventData, LlmFailure, LlmRequest, ModelInfo, SessionEvent, StreamEvent, Tool, ToolCall, Usage } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";

const model = (ref: string): ModelInfo => {
  const [provider, id] = ref.split("/") as [string, string];
  return {
    ref,
    provider,
    id,
    name: id,
    api: "fake-api",
    reasoning: false,
    thinkingLevels: [],
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 8_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
};

const usage = (input: number, output: number): Usage => ({
  ...emptyUsage,
  input,
  output,
  totalTokens: input + output,
  cost: { ...emptyUsage.cost, total: (input + output) / 1000 },
});

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "fake-api",
  provider: "fake",
  model: "m1",
  usage: usage(10, 5),
  stopReason,
  timestamp: 1,
  ...extra,
});

export type Script = Stream.Stream<StreamEvent, LlmError>;

export const reply = (text: string): Script =>
  Stream.fromIterable<StreamEvent>([
    { type: "start" },
    { type: "text-delta", index: 0, delta: text.slice(0, 2) },
    { type: "text-delta", index: 0, delta: text.slice(2) },
    { type: "done", message: assistant([{ type: "text", text }], "stop") },
  ]);

export const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });

export const useTools = (...calls: ToolCall[]): Script =>
  Stream.fromIterable<StreamEvent>([
    { type: "start" },
    ...calls.flatMap((toolCall, index): StreamEvent[] => [
      { type: "toolcall-start", index, id: toolCall.id, name: toolCall.name },
      { type: "toolcall-end", index, toolCall },
    ]),
    { type: "done", message: assistant(calls, "toolUse") },
  ]);

export const failWith = (errorMessage: string, failure?: LlmFailure): Script =>
  Stream.fromIterable<StreamEvent>([
    { type: "start" },
    { type: "error", message: assistant([], "error", { errorMessage }), ...(failure === undefined ? {} : { failure }) },
  ]);

/** A response of `content` that stops for `stopReason`, whatever it holds. */
export const respond = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): Script =>
  Stream.fromIterable<StreamEvent>([{ type: "start" }, { type: "done", message: assistant(content, stopReason) }]);

/** Emits some text, then never settles: for cancellation. */
export const hang = (text: string): Script =>
  Stream.concat(Stream.fromIterable<StreamEvent>([{ type: "start" }, { type: "text-delta", index: 0, delta: text }]), Stream.never);

/** Emits `script` once `gate` opens. */
export const gated = (gate: Deferred.Deferred<void>, script: Script): Script => Stream.unwrap(Effect.as(Deferred.await(gate), script));

/** A model that plays one script per call, in order, and records every request it received. */
export function fakeLlm(scripts: readonly (Script | ((request: LlmRequest) => Script))[], models: readonly string[] = ["fake/m1"]) {
  const requests: LlmRequest[] = [];
  const queue = [...scripts];
  const plugin = definePlugin({
    id: "llm",
    provides: [Llm],
    layer: Layer.succeed(Llm, {
      providers: Effect.succeed([]),
      models: () => Effect.succeed(models.map(model)),
      model: (ref) =>
        models.includes(ref) ? Effect.succeed(model(ref)) : Effect.fail(new LlmError({ reason: "UnknownModel", message: `Unknown model ${ref}` })),
      stream: (request) => {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) return Stream.fail(new LlmError({ reason: "UnknownModel", message: "no script left" }));
        return typeof next === "function" ? next(request) : next;
      },
      login: () => Effect.void,
      logout: () => Effect.void,
      addCustom: () => Effect.succeed("custom"),
      removeCustom: () => Effect.void,
      setLogo: () => Effect.void,
    }),
  });
  return { plugin, requests };
}

export const host = (compositionId = "comp-1") =>
  definePlugin({
    id: "host",
    provides: [HostControl],
    layer: Layer.succeed(HostControl, {
      runtime: [HostControl.key],
      plugins: Effect.succeed([]),
      composition: Effect.succeed({ id: compositionId, plugins: [] }),
      restart: () => Effect.void,
      reload: Effect.die("unused"),
      configure: () => Effect.die("unused"),
      ui: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
      configureUi: () => Effect.die("unused"),
    }),
  });

export const paths = (dir: string, cwd: string) => pathsPlugin(dir, { cwd });

export const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "lemma-agent-"));

/** Tools under test, registered by a plugin with id `test-tools`. */
export function testTools(extra: readonly Tool<any>[] = []) {
  const executed: string[] = [];
  const echo: Tool<{ readonly text: string }> = {
    name: "echo",
    description: "Echoes text back.",
    input: Schema.Struct({ text: Schema.String }),
    execute: async ({ text }) => {
      executed.push(text);
      return new ToolResult({ content: [{ type: "text", text: `echo: ${text}` }], details: { length: text.length } });
    },
  };
  const plugin: Plugin = definePlugin({
    id: "test-tools",
    requires: [Tools],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const registry = yield* Tools;
        for (const tool of [echo, ...extra]) yield* registry.register(tool);
      }),
    ),
  });
  return { plugin, executed };
}

/** Records agent events so tests can assert on what a UI would have seen. */
export function recorder() {
  const started: string[] = [];
  const ended: { turnId: string; reason: string; usage: Usage }[] = [];
  const deltas: StreamEvent[] = [];
  const plugin = definePlugin({
    id: "recorder",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        yield* owner.observe(TurnStarted, ({ turnId }) =>
          Effect.sync(() => {
            started.push(turnId);
          }),
        );
        yield* owner.observe(TurnEnded, ({ turnId, reason, usage }) =>
          Effect.sync(() => {
            ended.push({ turnId, reason, usage });
          }),
        );
        yield* owner.observe(
          AssistantDelta,
          ({ event }) =>
            Effect.sync(() => {
              deltas.push(event);
            }),
          { buffer: 1024 },
        );
      }),
    ),
  });
  return { plugin, started, ended, deltas };
}

/** Polls until the predicate holds; dies after five seconds so a wrong expectation fails fast. */
export function waitFor<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean): Effect.Effect<A, E, R> {
  const poll: Effect.Effect<A, E, R> = Effect.flatMap(effect, (value) =>
    predicate(value) ? Effect.succeed(value) : Effect.andThen(Effect.sleep(Duration.millis(5)), poll),
  );
  return poll.pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
}

export interface AgentSetup {
  readonly scripts: readonly (Script | ((request: LlmRequest) => Script))[];
  readonly tools?: readonly Tool<any>[];
  readonly plugins?: readonly Plugin[];
  /** The agent's config. */
  readonly config?: Record<string, unknown>;
  readonly models?: readonly string[];
  /** In place of the sessions store. */
  readonly sessions?: Plugin;
  /** Runs on Effect's test clock: waits (a retry's) last until the body adjusts it. */
  readonly testClock?: boolean;
}

/**
 * One run of the agent over `dir`. When `body` returns, the core closes, as
 * when the host stops: a turn still running is suspended, and the next run
 * over the same `dir` resumes it.
 */
export const runAgent = <A, E>(
  dir: string,
  setup: AgentSetup,
  body: (fixture: {
    readonly requests: LlmRequest[];
    readonly rec: ReturnType<typeof recorder>;
    readonly executed: string[];
  }) => Effect.Effect<A, E, Agent | Sessions | Events>,
) => {
  const llm = fakeLlm(setup.scripts, setup.models);
  const rec = recorder();
  const toolset = testTools(setup.tools);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore(
          [paths(dir, dir), host(), setup.sessions ?? sessions, tools, toolset.plugin, llm.plugin, agent, rec.plugin, ...(setup.plugins ?? [])],
          { configs: { agent: setup.config ?? {} } },
        );
        return yield* core.run(body({ requests: llm.requests, rec, executed: toolset.executed }));
      }),
    ).pipe(setup.testClock === true ? Effect.provide(TestClock.layer()) : (effect) => effect),
  );
};

/** A prompt of one text part. */
export const text = (value: string) => [{ type: "text" as const, text: value }];
export const types = (events: readonly SessionEvent[]) => events.map((event) => event.data.type);
export const ofType = <T extends EventData["type"]>(events: readonly SessionEvent[], type: T) =>
  events.flatMap((event) => (event.data.type === type ? [event.data as Extract<EventData, { type: T }>] : []));
export const newSession = Effect.flatMap(Sessions, (store) => store.create());
export const log = (sessionId: string) => Effect.flatMap(Sessions, (store) => store.events(sessionId));
