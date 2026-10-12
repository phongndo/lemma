// `pnpm sim`: runs the harness simulation, printing each seed before it runs, so a failure always says how to replay it.
//
//   pnpm sim                         a random seed
//   pnpm sim --seed 7                seed 7
//   pnpm sim --seed 7 --count 100    seeds 7 to 106
//   pnpm sim --forever               random seeds until one fails
//   pnpm sim --seed 7 --dump         seed 7, then every session's log as it was left
//   pnpm sim --seed 1 --digest       the short determinism run's disk digest (tests/determinism.test.ts)
//
// `--ticks <n>` sets the safety phase's length (default 200). Exits 1 on the first failing seed.
process.env.TZ = "UTC";

import { parseArgs } from "node:util";
import { Cause } from "effect";
import type { SessionEvent } from "@lemma/sessions";
import { digestRun } from "./run.ts";
import { World } from "./world.ts";

const { values } = parseArgs({
  options: {
    seed: { type: "string" },
    count: { type: "string", default: "1" },
    ticks: { type: "string", default: "200" },
    forever: { type: "boolean" },
    dump: { type: "boolean" },
    digest: { type: "boolean" },
  },
});
const integer = (name: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a whole number`);
  return parsed;
};
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);
const first = values.seed === undefined ? randomSeed() : integer("seed", values.seed);
const count = values.forever === true ? Infinity : integer("count", values.count);
const ticks = integer("ticks", values.ticks);

if (values.digest === true) {
  console.log(`seed ${first}`);
  console.log(await digestRun(first));
  process.exit(0);
}

/** A failure's causes, nested ones indented: a plugin's fault names the error that caused it. */
const explain = (error: unknown, depth = 0): string[] => {
  if (depth > 6 || error === undefined) return [];
  const message = error instanceof Error ? error.message : String((error as { readonly message?: unknown } | null)?.message ?? error);
  const line = `${"  ".repeat(depth)}${(error as { readonly _tag?: string } | null)?._tag ?? (error instanceof Error ? error.name : "error")}: ${message}`;
  const cause = (error as { readonly cause?: unknown } | null)?.cause;
  const inner = Cause.isCause(cause) ? Cause.prettyErrors(cause) : cause === undefined ? [] : [cause];
  return [line, ...inner.flatMap((each) => explain(each, depth + 1))];
};

/** An event in a line: its seq, id, parent, and what it is. */
const describeEvent = (event: SessionEvent): string => {
  const data = event.data;
  const what =
    data.type === "message"
      ? `${data.message.role}${data.message.role === "toolResult" ? ` ${data.message.toolCallId}` : ""}${data.message.role === "assistant" ? ` ${data.message.stopReason}` : ""}${data.requestId === undefined ? "" : ` ${data.requestId}`}`
      : data.type === "custom"
        ? `${data.kind} ${JSON.stringify(data.data).slice(0, 100)}`
        : data.type === "turn-end"
          ? `${data.reason}${data.error === undefined ? "" : ` ${data.error}`}`
          : "";
  const turn = "turnId" in data && data.turnId !== undefined ? ` turn ${data.turnId}` : "";
  const step = "stepId" in data && data.stepId !== undefined ? ` step ${data.stepId}` : "";
  return `${event.seq} ${event.id} <- ${event.parent ?? "root"} ${data.type}${turn}${step} ${what}`.trimEnd();
};

let failed = false;
for (let index = 0; index < count && !failed; index++) {
  const seed = values.forever === true && index > 0 ? randomSeed() : first + index;
  console.log(`seed ${seed}`);
  const world = new World({ seed, ticks });
  const started = performance.now();
  try {
    await world.run();
    const simulated = Number(world.sim.clock.elapsed / 1_000_000n) / 1000;
    console.log(`  ok: ${Math.round(performance.now() - started)} ms for ${simulated} s simulated, ${world.calls.length} model calls`);
  } catch (error) {
    failed = true;
    console.log(world.describe().replace(/^/gm, "  "));
    for (const line of explain(error)) console.log(`  ${line}`);
    console.log(`  replay: pnpm --filter @lemma/sim sim --seed ${seed} --ticks ${ticks} --dump`);
  }
  if (values.dump === true) {
    for (const [sessionId, events] of world.fileEvents()) {
      console.log(`session ${sessionId}`);
      for (const event of events) console.log(`  ${describeEvent(event)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
