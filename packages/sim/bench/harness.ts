// The harness benchmark: the real agent loop, sessions store, tool registry, and compaction, in simulated time, on a
// file system in memory, with a model that answers without waiting. Simulated waits cost no wall time, so a step's wall
// time is the harness's, with the driver, the scripted model and tools, the file system, and `meter` beside it. It
// records, for a session at each length in `LENGTHS`:
//
// - counts per step, the same on every machine (hard budgets in packages/core/bench/budgets.ts): events the agent
//   reads back from the store, bytes and syncs written, hooks run, and events published; and the most of each a turn
//   took, so one costly turn cannot hide in the average;
// - timings per step, advisory: the time a step takes (a tool step's and an answer step's apart), and how much longer
//   it takes at 10,000 entries than at 1,000; the time from the model's text delta to an observer's hearing it; and
//   the heap.
//
// The estimate it is held to is in README.md#the-harness-benchmark. Run: `pnpm harness:bench`.
// `LEMMA_HARNESS_BENCH_ENTRIES` sets the longest session (default 10,000); `pnpm test` runs it at 300.
process.env.TZ = "UTC";

import { Effect } from "effect";
import type { Context } from "effect";
import { assert, definePlugin, PluginContext } from "@lemma/core";
import { Agent, AgentContinueHook, AgentInputHook, AgentRequestHook, AssistantDelta, QueueChanged, TurnEnded, TurnStarted } from "@lemma/agent";
import compaction from "@lemma/context-compaction";
import type { Usage } from "@lemma/llm";
import { SessionAppended, SessionChanged, Sessions } from "@lemma/sessions";
import { ToolExecuted, ToolExecuteHook, ToolOutput } from "@lemma/tools";
import { finish, record, recordAverage } from "../../core/bench/budgets.ts";
import type { Unit } from "../../core/bench/report.ts";
import { SimHost } from "../src/host.ts";
import { MemFs } from "../src/memfs.ts";
import { simModel } from "../src/model.ts";
import type { Answering } from "../src/model.ts";
import { Simulation } from "../src/simulation.ts";
import { simTools } from "../src/tools.ts";

const longest = Number(process.env.LEMMA_HARNESS_BENCH_ENTRIES ?? 10_000);
const LENGTHS = [100, 1_000, 10_000].filter((length) => length <= longest);
/** Turns measured at each length: two steps each. */
const MEASURED_TURNS = 10;

const usage = (input: number): Usage => ({
  input,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** About what each of this benchmark's messages holds, in compaction's estimate (four characters a token). */
const TOKENS_PER_MESSAGE = 8;
const CONTEXT_WINDOW = 4_000;

/** The text compaction's request ends with. */
const SUMMARIZE = "Summarize the conversation above.";

/**
 * A turn of two steps: the model calls `echo`, then answers its result in five deltas. It reports the context a
 * request filled as compaction estimates it (its messages are short: about 8 tokens each), in a window of 4,000 tokens,
 * so a session compacts every few dozen turns, from a few hundred entries on, as a real one does once its context is
 * full: the history a request carries stays within the same bounds at 1,000 entries as at 10,000. A summary request
 * (compaction's) gets a summary.
 */
const answering: Answering = (request) => {
  const last = request.messages.at(-1);
  const deltas = ["Here ", "is ", "what ", "it ", "said."].map((text) => ({ text, afterMs: 20 }));
  if (last?.role === "user" && last.content.some((part) => part.type === "text" && part.text.endsWith(SUMMARIZE))) {
    return { kinds: ["summary"], latencyMs: 300, deltas, usage: usage(500), ending: { kind: "done", calls: [] } };
  }
  const used = usage(request.messages.length * TOKENS_PER_MESSAGE);
  if (last?.role === "toolResult") return { kinds: ["reply"], latencyMs: 300, deltas, usage: used, ending: { kind: "done", calls: [] } };
  const id = `call-${request.messages.length}`;
  return {
    kinds: ["tools"],
    latencyMs: 300,
    deltas,
    usage: used,
    ending: { kind: "done", calls: [{ type: "toolCall", id, name: "echo", arguments: { text: "hello" } }] },
  };
};

/** What the harness does, counted. */
const counts = {
  /** Steps taken: `step-start` events appended. */
  steps: 0,
  /** Events the store hands back when the agent reads a branch or a log: what a step walks. */
  eventsRead: 0,
  hooks: 0,
  published: 0,
  compactions: 0,
};
/**
 * When each text delta of a measured turn was emitted, oldest first, and how long an observer of `AssistantDelta` took
 * to hear it: one call runs at a time, and the agent publishes its deltas in order, so the next one heard is the oldest
 * one emitted. The turns that grow the session, and a summary's deltas (which are not published), are not noted.
 */
const emitted: number[] = [];
const heard: number[] = [];
let measuring = false;
let step: { start: number; tool: boolean } | undefined;
const stepSamples = { tool: [] as number[], answer: [] as number[] };

const counting = (sessions: Context.Service.Shape<typeof Sessions>): Context.Service.Shape<typeof Sessions> => ({
  ...sessions,
  branch: (sessionId, options) => Effect.tap(sessions.branch(sessionId, options), (events) => Effect.sync(() => void (counts.eventsRead += events.length))),
  events: (sessionId, options) => Effect.tap(sessions.events(sessionId, options), (events) => Effect.sync(() => void (counts.eventsRead += events.length))),
  append: (sessionId, data, options) =>
    Effect.tap(sessions.append(sessionId, data, options), () =>
      Effect.sync(() => {
        if (data.type === "step-start") counts.steps++;
        if (data.type === "compaction") counts.compactions++;
        if (!measuring) return;
        if (data.type === "step-start") step = { start: performance.now(), tool: false };
        if (data.type === "message" && data.message.role === "assistant" && data.message.content.some((part) => part.type === "toolCall") && step !== undefined)
          step.tool = true;
        if (data.type === "step-end" && step !== undefined) {
          stepSamples[step.tool ? "tool" : "answer"].push(performance.now() - step.start);
          step = undefined;
        }
      }),
    ),
});

/**
 * Counts every public hook the harness runs and every event it publishes, passing each on: what a step costs in the
 * kernel's dispatch. The README's "What it measures" says which hooks a step runs that it cannot count.
 */
const meter = definePlugin({
  id: "bench.meter",
  setup: function* () {
    const owner = yield* PluginContext;
    for (const hook of [AgentInputHook, AgentRequestHook, AgentContinueHook, ToolExecuteHook] as const) {
      yield* owner.on(hook as typeof AgentRequestHook, (input, next) =>
        Effect.andThen(
          Effect.sync(() => void counts.hooks++),
          next(input),
        ),
      );
    }
    for (const event of [SessionAppended, SessionChanged, TurnStarted, TurnEnded, QueueChanged, ToolOutput, ToolExecuted] as const) {
      yield* owner.observe(event as typeof TurnStarted, () => Effect.sync(() => void counts.published++), { buffer: 1 << 16, overflow: "suspend" });
    }
    yield* owner.observe(
      AssistantDelta,
      ({ event }) =>
        Effect.sync(() => {
          counts.published++;
          if (!measuring || event.type !== "text-delta") return;
          const at = emitted.shift();
          assert(at !== undefined, "a measured text delta was heard without its emission");
          heard.push(performance.now() - at);
        }),
      { buffer: 1 << 16, overflow: "suspend" },
    );
  },
});

// `Verify` off: the checks too costly for every call stay out, as in production.
const sim = new Simulation({ seed: 1, verify: false });
const fs = new MemFs();
let summarizing = false;
const model = simModel(sim.random.split("model"), {
  answering: (request, prng) => {
    const answer = answering(request, prng);
    summarizing = answer.kinds.includes("summary");
    return answer;
  },
  keep: false,
  contextWindow: CONTEXT_WINDOW,
  emit: (event) => {
    if (measuring && !summarizing && event.type === "text-delta") emitted.push(performance.now());
  },
});
const host = await SimHost.start(
  sim,
  fs,
  1,
  {
    plugins: [compaction, model.plugin, simTools(sim.random.split("tools")).plugin, meter],
    configs: { "agent.loop": { maxSteps: 4 } },
    wrapSessions: counting,
  },
  new Set([1]),
);

const run = <A, E>(body: (store: Context.Service.Shape<typeof Sessions>) => Effect.Effect<A, E>) =>
  host.run(
    Effect.gen(function* () {
      return yield* body(yield* Sessions);
    }),
  );
const sessionId = await run((store) => Effect.map(store.create(), (info) => info.id));
const prompt = (n: number) =>
  host.run(
    Effect.gen(function* () {
      return yield* (yield* Agent).prompt(sessionId, [{ type: "text", text: `prompt ${n}` }]);
    }),
  );
/** The session's length, as its info says: read without counting, as the benchmark's own reading is not the harness's. */
const entries = () => run((store) => Effect.map(store.get(sessionId), (info) => info.lastSeq));

let turns = 0;
const perStep: Record<number, { readonly ms: number }> = {};
for (const target of LENGTHS) {
  // Grow the session to `target` entries, unmeasured: each turn logs about thirteen.
  while ((await entries()) < target) await prompt(turns++);
  await sim.settle();
  const before = { ...counts, ...fs.counts };
  emitted.length = 0;
  heard.length = 0;
  stepSamples.tool.length = 0;
  stepSamples.answer.length = 0;
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  measuring = true;
  const started = performance.now();
  const turnMs: number[] = [];
  const maxima = { syncs: 0, bytes: 0, hooks: 0, events: 0 };
  for (let n = 0; n < MEASURED_TURNS; n++) {
    const previous = { ...counts, ...fs.counts };
    const turnStart = performance.now();
    await prompt(turns++);
    await sim.settle();
    turnMs.push((performance.now() - turnStart) / 2);
    maxima.syncs = Math.max(maxima.syncs, fs.counts.syncs - previous.syncs);
    maxima.bytes = Math.max(maxima.bytes, fs.counts.bytesWritten - previous.bytesWritten);
    maxima.hooks = Math.max(maxima.hooks, counts.hooks - previous.hooks);
    maxima.events = Math.max(maxima.events, counts.published - previous.published);
  }
  await sim.settle();
  const ms = performance.now() - started;
  measuring = false;
  const after = { ...counts, ...fs.counts };
  const steps = after.steps - before.steps;
  assert(steps === MEASURED_TURNS * 2, `the benchmark measured ${steps} steps instead of ${MEASURED_TURNS * 2}`);
  assert(emitted.length === 0 && heard.length === steps * 5, `the benchmark heard ${heard.length} text deltas and left ${emitted.length} undelivered`);
  const per = (name: string, key: keyof typeof after, unit: Unit) =>
    recordAverage(`Harness / ${target} entries / ${name} per step`, after[key] - before[key], steps, unit);
  perStep[target] = { ms: ms / steps };
  record(`Harness / ${target} entries / ms per step`, ms / steps, "ms/step", turnMs);
  for (const [kind, samples] of Object.entries(stepSamples)) {
    assert(samples.length === MEASURED_TURNS, `the benchmark timed ${samples.length} ${kind} steps instead of ${MEASURED_TURNS}`);
    record(`Harness / ${target} entries / ${kind} ms per step`, samples.reduce((sum, value) => sum + value, 0) / samples.length, "ms/step", samples);
  }
  per("events read", "eventsRead", "count/step");
  per("bytes written", "bytesWritten", "bytes/step");
  per("syncs", "syncs", "count/step");
  per("hooks run", "hooks", "count/step");
  per("events published", "published", "count/step");
  for (const [what, value] of Object.entries(maxima))
    record(`Harness / ${target} entries / max ${what} per turn`, value, what === "bytes" ? "bytes/turn" : "count/turn");
  record(`Harness / ${target} entries / heap MB`, heap / 1e6, "MB");
  heard.sort((a, b) => a - b);
  record(`Harness / ${target} entries / delta to observer ms p50`, heard[Math.floor(heard.length * 0.5)]!, "ms", heard);
  record(`Harness / ${target} entries / delta to observer ms p99`, heard[Math.min(heard.length - 1, Math.floor(heard.length * 0.99))]!, "ms", heard);
}
record("Harness / compactions", counts.compactions, "count");
if (perStep[1_000] !== undefined && perStep[10_000] !== undefined) {
  record("Harness / step time 10k vs 1k entries", perStep[10_000].ms / perStep[1_000].ms, "ratio");
}
// The scripted model and tools answered as they always do: the benchmark measured the work it means to.
const messages = (await run((store) => store.events(sessionId))).flatMap((event) => (event.data.type === "message" ? [event.data.message] : []));
for (const message of messages) {
  const written = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  if (message.role === "assistant") assert(written === "Here is what it said.", "benchmark changed the scripted model's answer");
  if (message.role === "toolResult") assert(!message.isError && written === "echo: hello", "benchmark changed the tool's result");
}
await host.stop();
finish("harness", { lengths: LENGTHS, measuredTurns: MEASURED_TURNS });
