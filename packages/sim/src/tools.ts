import { Duration, Effect, Schema } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { ToolResult, Tools } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import type { Prng } from "./random.ts";

/** How the tools misbehave, each a chance per call, drawn once per run. */
export interface ToolFaults {
  /** The call fails, after the output it printed. */
  readonly fail: number;
  /** The call runs for minutes rather than seconds. */
  readonly slow: number;
}

export const NO_TOOL_FAULTS: ToolFaults = { fail: 0, slow: 0 };

/** What the tools did, across every host of a run: how many times each call of `work`, unsafe to repeat, began. */
export interface ToolRecord {
  readonly began: Map<string, number>;
}

export const newToolRecord = (): ToolRecord => ({ began: new Map() });

const Input = Schema.Struct({ text: Schema.String, steps: Schema.optional(Schema.Number) });

/**
 * The tools a simulated host offers, on Effect's clock: `echo`, quick, and safe to repeat and to run beside others;
 * and `work`, which prints a line per step, takes a while, may fail, and is unsafe to repeat, as a command that
 * changes something is: `record.began` counts each of its calls' starts, which a resumed turn must never repeat.
 */
export const simTools = (prng: Prng, options: { readonly faults?: ToolFaults; readonly record?: ToolRecord } = {}) => {
  const faults = options.faults ?? NO_TOOL_FAULTS;
  const record = options.record ?? newToolRecord();
  const echo: Tool<typeof Input.Type> = {
    name: "echo",
    description: "Echoes text back.",
    input: Input,
    replay: "safe",
    parallel: "safe",
    execute: ({ text }) =>
      Effect.as(Effect.sleep(Duration.millis(prng.between(1, 500))), new ToolResult({ content: [{ type: "text", text: `echo: ${text}` }] })),
  };
  const work: Tool<typeof Input.Type> = {
    name: "work",
    description: "Does some work, printing a line per step.",
    input: Input,
    execute: ({ text, steps = 1 }, context) =>
      Effect.gen(function* () {
        record.began.set(context.toolCallId, (record.began.get(context.toolCallId) ?? 0) + 1);
        const slow = prng.chance(faults.slow);
        for (let step = 1; step <= steps; step++) {
          yield* Effect.sleep(Duration.millis(slow ? prng.between(30_000, 180_000) : prng.between(10, 3_000)));
          context.update?.(`${text}: step ${step} of ${steps}\n`);
        }
        if (prng.chance(faults.fail)) return yield* Effect.fail(new Error(`${text} failed`));
        return new ToolResult({ content: [{ type: "text", text: `${text}: done` }] });
      }),
  };
  const plugin = definePlugin({
    id: "sim.tools",
    setup: function* () {
      const owner = yield* PluginContext;
      yield* owner.add(Tools, echo);
      yield* owner.add(Tools, work);
    },
  });
  return { plugin, record };
};
