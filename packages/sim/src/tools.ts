import { Duration, Effect, Schema } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { ToolResult, Tools } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import type { Prng } from "./random.ts";

/** The tools a simulated host offers, running as long as `prng` draws, on Effect's clock. */
export const simTools = (prng: Prng) => {
  const executed: string[] = [];
  const echo: Tool<{ readonly text: string }> = {
    name: "echo",
    description: "Echoes text back.",
    input: Schema.Struct({ text: Schema.String }),
    replay: "safe",
    execute: ({ text }) =>
      Effect.andThen(
        Effect.sleep(Duration.millis(prng.between(1, 500))),
        Effect.sync(() => {
          executed.push(text);
          return new ToolResult({ content: [{ type: "text", text: `echo: ${text}` }] });
        }),
      ),
  };
  const plugin = definePlugin({
    id: "sim.tools",
    setup: function* () {
      const owner = yield* PluginContext;
      yield* owner.add(Tools, echo);
    },
  });
  return { plugin, executed };
};
