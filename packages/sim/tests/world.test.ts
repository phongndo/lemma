import { describe, expect, it, onTestFailed } from "vitest";
import { emptyUsage } from "@lemma/llm";
import type { Message } from "@lemma/llm";
import { ACTIONS, Checker, digestOf, malformed, transcriptProblems, World } from "../src/index.ts";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { saveWorldFailure } from "../src/artifacts.ts";

/*
 * The harness under a workload and faults drawn from each seed (`World`): a safety phase with the faults on, a liveness
 * phase with them off, then the checker's audit of the log it left. `pnpm test` runs 100 seeds; the nightly job runs
 * many more (`LEMMA_HARNESS_RUNS`). A failure prints the seed and the command that replays it.
 *
 * Across the seeds, every kind of action, fault, and outcome must show up at least once: a kind that never does is a
 * part of the space no run reaches, which a generator can lose without anyone noticing (TigerBeetle's "Fuzzer Blind
 * Spots").
 */

const runs = Number(process.env.LEMMA_HARNESS_RUNS ?? 100);
const first = Number(process.env.LEMMA_HARNESS_SEED ?? 1);
const ticks = Number(process.env.LEMMA_HARNESS_TICKS ?? 120);

/**
 * What the seeds together must reach: below 100 seeds (a run cut short to debug one), it is not asked. The rarest
 * kinds happen in about a tenth of runs, so any 100 seeds reach each of them but for about one window in a thousand.
 */
const REACHED = [
  ...ACTIONS.map((action) => `action ${action}`),
  ...["reply", "tools", "transient", "rateLimit", "fatal", "overflow", "stall", "cut", "malformed", "bigUsage", "summary", "summary failed"].map(
    (kind) => `model ${kind}`,
  ),
  "tool fail",
  "tool slow",
  "tool output",
  ...["inputSlow", "inputFail", "inputAnswer", "requestSlow", "requestFail"].map((kind) => `hook ${kind}`),
  ...["write", "sync", "truncate", "rename", "open"].map((operation) => `disk ${operation}`),
  "crash",
  "crash mid-write",
  "crash while starting",
  // A host saw a write fail, then crashed: recovery starts from what the failed write left.
  "crash after a failed write",
  "stop",
  // What actions did, not that they were drawn: a generator whose calls all fail would otherwise go on looking busy.
  "retried",
  "checked out",
  ...["agent.loop", "sessions.files", "tools.registry"].map((id) => `restarted ${id}`),
  ...["placed", "handled", "refused", "unknown", "failed Busy", "failed Retracted"].map((outcome) => `prompt ${outcome}`),
  ...["done", "error", "cancelled", "max-steps"].map((reason) => `turn ${reason}`),
  "appended compaction",
  "queue changed",
  "withdrawn",
];

describe("the harness simulation", () => {
  it("rejects duplicate tool calls and results, without rejecting reused ids in another response", () => {
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "a", name: "echo", arguments: {} }],
      api: "sim",
      provider: "sim",
      model: "model",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 0,
    };
    const result: Message = { role: "toolResult", toolCallId: "a", toolName: "echo", content: [], isError: false, timestamp: 0 };
    expect(malformed([{ ...assistant, content: [...assistant.content, ...assistant.content] }, result])).toEqual(["message 0: duplicate tool call a"]);
    expect(malformed([assistant, result, result])).toEqual(["message 2: a result for a, which no pending call made"]);
    expect(malformed([assistant, result, assistant, result])).toEqual([]);
    expect(malformed([assistant])).toEqual(["calls a have no result at the end"]);
    expect(
      malformed([
        { ...assistant, stopReason: "error" },
        { ...result, isError: true, content: [{ type: "text", text: "interrupted" }] },
      ]),
    ).toEqual([]);
  });

  it("rejects an acknowledged event that disappears or changes during recovery", () => {
    const event: SessionEvent = {
      seq: 1,
      id: "e",
      parent: null,
      at: 1,
      data: { type: "message", message: { role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 } },
    };
    for (const recovered of [[], [{ ...event, at: 2 }]]) {
      const checker = new Checker();
      checker.served("s", [event]);
      checker.survived("s", recovered);
      expect(checker.violations).toHaveLength(1);
      expect(checker.violations[0]).toMatch(/is gone|changed since/);
    }
  });

  it("rejects a log out of order, an event before its parent, and a request whose parts it cannot attribute", () => {
    const event = (seq: number, parent: string | null, data: EventData): SessionEvent => ({ id: `e${seq}`, seq, parent, at: seq, data });
    const user = event(1, null, { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } });
    const request = {
      type: "request" as const,
      turnId: "t",
      stepId: "s",
      model: "sim/model",
      composition: "test",
      system: "base\n\nskills",
      tools: [{ name: "echo", description: "Echo", parameters: {} }],
      contributions: [
        { source: "agent.loop", kind: "system" as const, label: "base", chars: 4 },
        { source: "skills", kind: "system" as const, label: "skills", chars: 6 },
        { source: "tools.echo", kind: "tool" as const, label: "echo", chars: 50 },
      ],
    };
    expect(transcriptProblems([user, event(2, "e1", request)])).toEqual([]);
    // A later request that leaves its unchanged system prompt and tools out is attributed against the ones in effect.
    expect(transcriptProblems([user, event(2, "e1", request), event(3, "e2", { ...request, system: undefined, tools: undefined })])).toEqual([]);
    expect(transcriptProblems([user, event(3, "e1", request)])).toEqual(["event e3: seq 3 at position 2"]);
    expect(transcriptProblems([event(2, "e1", request), { ...user, seq: 2 }].map((logged, index) => ({ ...logged, seq: index + 1 })))).toContain(
      "event e2: its parent e1 is not before it",
    );
    const attributed = (contributions: typeof request.contributions) => transcriptProblems([user, event(2, "e1", { ...request, contributions })]);
    expect(attributed(request.contributions.slice(1))).toEqual(["request e2: its system sections do not make up its system prompt"]);
    expect(attributed(request.contributions.slice(0, 2))).toEqual(["request e2: tool echo is not attributed"]);
    expect(attributed([{ ...request.contributions[0]!, source: "" }, ...request.contributions.slice(1)])).toEqual(["request e2: base names no source"]);
  });

  it(
    `keeps every invariant for seeds ${first} to ${first + runs - 1}, and reaches every kind of action, fault, and outcome`,
    { timeout: Math.max(60_000, runs * 5_000) },
    async () => {
      const reached = new Map<string, number>();
      let current = first;
      // Names the seed even when it never finishes, which the error below cannot.
      onTestFailed(() => console.error(`harness seed ${current}: pnpm --filter @lemma/sim sim --seed ${current} --ticks ${ticks} --dump`));
      for (let seed = first; seed < first + runs; seed++) {
        current = seed;
        const world = new World({ seed, ticks });
        try {
          await world.run();
        } catch (error) {
          saveWorldFailure(world, ticks, error);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${world.describe()}\nreplay: pnpm --filter @lemma/sim sim --seed ${seed} --ticks ${ticks} --dump`,
            { cause: error },
          );
        }
        for (const [what, count] of world.coverage()) reached.set(what, (reached.get(what) ?? 0) + count);
      }
      if (runs >= 100) expect(REACHED.filter((what) => (reached.get(what) ?? 0) === 0)).toEqual([]);
    },
  );

  it("is a seed's: run twice, it leaves the same disk and model calls", async () => {
    const once = new World({ seed: 7, ticks: 60 });
    const again = new World({ seed: 7, ticks: 60 });
    await once.run();
    await again.run();
    expect(digestOf(again.disk)).toBe(digestOf(once.disk));
    expect(again.calls.length).toBe(once.calls.length);
  });
});
