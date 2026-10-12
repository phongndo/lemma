// The harness benchmark: the real agent loop, sessions store, and tool registry, in simulated time, on a file system in
// memory, with a model that answers without waiting. Simulated waits cost no wall time, so the wall time a step takes
// is the harness's own. It records, for a session at each length in `LENGTHS`:
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

/** A turn of two steps: the model calls `echo`, then answers its result in five deltas. */
const answering: Answering = (request) => {
  const last = request.messages.at(-1);
  const deltas = ["Here ", "is ", "what ", "it ", "said."].map((text) => ({ text, afterMs: 20 }));
  if (last?.role === "toolResult") return { kinds: ["reply"], latencyMs: 300, deltas, usage: usage(), ending: { kind: "done", calls: [] } };
  const id = `call-${request.messages.length}`;
  return {
    kinds: ["tools"],
    latencyMs: 300,
    deltas,
    usage: usage(),
    ending: { kind: "done", calls: [{ type: "toolCall", id, name: "echo", arguments: { text: "hello" } }] },
  };
};
const usage = () => ({
  input: 1000,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1020,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** What the harness does, counted. */
const counts = {
  /** Events the store hands back when the agent reads a branch or a log: what each step walks. */
  eventsRead: 0,
  hooks: 0,
  published: 0,
};
/**
 * When each model event was emitted, oldest first, and how long an observer of `AssistantDelta` took to hear it: the
 * agent publishes every event of the stream (the model sends no `provider` event), in order, so the next one heard is
 * the oldest one emitted.
 */
const emitted: number[] = [];
const heard: number[] = [];

const counting = (sessions: Context.Service.Shape<typeof Sessions>): Context.Service.Shape<typeof Sessions> => ({
  ...sessions,
  branch: (sessionId, options) => Effect.tap(sessions.branch(sessionId, options), (events) => Effect.sync(() => void (counts.eventsRead += events.length))),
  events: (sessionId, options) => Effect.tap(sessions.events(sessionId, options), (events) => Effect.sync(() => void (counts.eventsRead += events.length))),
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

const sim = new Simulation({ seed: 1 });
const fs = new MemFs();
const model = simModel(sim.random.split("model"), { answering, keep: false, emit: () => void emitted.push(performance.now()) });
const host = await SimHost.start(
  sim,
  fs,
  1,
  {
    plugins: [model.plugin, simTools(sim.random.split("tools")).plugin, meter],
    configs: { "agent.loop": { maxSteps: 4 } },
    wrapSessions: counting,
  },
  new Set([1]),
);
const sessionId = await host.run(
  Effect.gen(function* () {
    return (yield* (yield* Sessions).create()).id;
  }),
);
const prompt = (n: number) =>
  host.run(
    Effect.gen(function* () {
      const agent = yield* Agent;
      return yield* agent.prompt(sessionId, [{ type: "text", text: `prompt ${n}` }]);
    }),
  );
const entries = () =>
  host.run(
    Effect.gen(function* () {
      return (yield* (yield* Sessions).events(sessionId)).length;
    }),
  );

let turns = 0;
const perStep: Record<number, { readonly ms: number; readonly eventsRead: number }> = {};
for (const length of LENGTHS) {
  // Grow the session to `length` entries, unmeasured.
  for (let have = await entries(); have < length; have = await entries()) await prompt(turns++);
  const before = { ...counts, ...fs.counts, steps: model.asked() };
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let n = 0; n < MEASURED_TURNS; n++) await prompt(turns++);
  const ms = performance.now() - started;
  const after = { ...counts, ...fs.counts, steps: model.asked() };
  const steps = after.steps - before.steps;
  const per = (key: keyof typeof after) => Math.round(((after[key] as number) - (before[key] as number)) / steps);
  perStep[length] = { ms: ms / steps, eventsRead: per("eventsRead") };
  record(`Harness / ${length} entries / ms per step`, ms / steps);
  record(`Harness / ${length} entries / events read per step`, per("eventsRead"));
  record(`Harness / ${length} entries / bytes written per step`, per("bytesWritten"));
  record(`Harness / ${length} entries / syncs per step`, per("syncs"));
  record(`Harness / ${length} entries / hooks run per step`, per("hooks"));
  record(`Harness / ${length} entries / events published per step`, per("published"));
  record(`Harness / ${length} entries / heap MB`, heap / 1e6);
}
if (perStep[1_000] !== undefined && perStep[10_000] !== undefined) {
  record("Harness / step time 10k vs 1k entries", perStep[10_000].ms / perStep[1_000].ms);
  record("Harness / events read 10k vs 1k entries", perStep[10_000].eventsRead / perStep[1_000].eventsRead);
}
if (heard.length > 0) {
  const sorted = [...heard].sort((a, b) => a - b);
  record("Harness / delta to observer ms p50", sorted[Math.floor(sorted.length * 0.5)]!);
  record("Harness / delta to observer ms p99", sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!);
}
await host.stop();
finish("harness");
