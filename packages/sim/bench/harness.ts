// The harness benchmark: the real agent loop, sessions store, tool registry, and compaction, in simulated time, on a
// file system in memory, with a model that answers without waiting. Simulated waits cost no wall time, so the wall time
// a step takes is the harness's own. It records, for a session at each length in `LENGTHS`:
//
// - counts per step, the same on every machine (hard budgets in packages/core/bench/budgets.ts): events the agent
//   reads back from the store, bytes and syncs written, hooks run, and events published;
// - timings per step, advisory: the time a step takes, and how much longer it takes at 10,000 entries than at 1,000;
//   the time from the model's delta to an observer's hearing it; and the heap.
//
// The estimate it is held to is in README.md#the-harness-benchmark. Run: `pnpm harness:bench`.
// `LEMMA_HARNESS_BENCH_ENTRIES` sets the longest session (default 10,000); `pnpm test` runs it at 300.
process.env.TZ = "UTC";

import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { Agent, AgentContinueHook, AgentInputHook, AgentRequestHook, AssistantDelta, QueueChanged, TurnEnded, TurnStarted } from "@lemma/agent";
import compaction from "@lemma/context-compaction";
import type { Usage } from "@lemma/llm";
import { SessionAppended, SessionChanged, Sessions } from "@lemma/sessions";
import { ToolExecuted, ToolExecuteHook, ToolOutput } from "@lemma/tools";
import { finish, record } from "../../core/bench/budgets.ts";
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
 * When each model event of a step's call was emitted, oldest first, and how long an observer of `AssistantDelta` took
 * to hear it: the agent publishes every event of a step's stream (the model sends no `provider` event), in order, so
 * the next one heard is the oldest one emitted. A summary's events are not published, and are not noted.
 */
const emitted: number[] = [];
const heard: number[] = [];

const counting = (sessions: Context.Service.Shape<typeof Sessions>): Context.Service.Shape<typeof Sessions> => ({
  ...sessions,
  branch: (sessionId, options) => Effect.tap(sessions.branch(sessionId, options), (events) => Effect.sync(() => void (counts.eventsRead += events.length))),
  events: (sessionId, options) => Effect.tap(sessions.events(sessionId, options), (events) => Effect.sync(() => void (counts.eventsRead += events.length))),
  append: (sessionId, data, options) =>
    Effect.tap(sessions.append(sessionId, data, options), () =>
      Effect.sync(() => {
        if (data.type === "step-start") counts.steps++;
        if (data.type === "compaction") counts.compactions++;
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
      () =>
        Effect.sync(() => {
          counts.published++;
          const at = emitted.shift();
          if (at !== undefined) heard.push(performance.now() - at);
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
  emit: () => void (summarizing ? undefined : emitted.push(performance.now())),
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
  const before = { ...counts, ...fs.counts };
  emitted.length = 0;
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let n = 0; n < MEASURED_TURNS; n++) await prompt(turns++);
  const ms = performance.now() - started;
  const after = { ...counts, ...fs.counts };
  const steps = after.steps - before.steps;
  const per = (key: keyof typeof after) => Math.round((after[key] - before[key]) / steps);
  perStep[target] = { ms: ms / steps };
  record(`Harness / ${target} entries / ms per step`, ms / steps);
  record(`Harness / ${target} entries / events read per step`, per("eventsRead"));
  record(`Harness / ${target} entries / bytes written per step`, per("bytesWritten"));
  record(`Harness / ${target} entries / syncs per step`, per("syncs"));
  record(`Harness / ${target} entries / hooks run per step`, per("hooks"));
  record(`Harness / ${target} entries / events published per step`, per("published"));
  record(`Harness / ${target} entries / heap MB`, heap / 1e6);
}
record("Harness / compactions", counts.compactions);
if (perStep[1_000] !== undefined && perStep[10_000] !== undefined) {
  record("Harness / step time 10k vs 1k entries", perStep[10_000].ms / perStep[1_000].ms);
}
if (heard.length > 0) {
  const sorted = [...heard].sort((a, b) => a - b);
  record("Harness / delta to observer ms p50", sorted[Math.floor(sorted.length * 0.5)]!);
  record("Harness / delta to observer ms p99", sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!);
}
await host.stop();
finish("harness");
