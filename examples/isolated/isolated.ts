import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { ToolResult, Tools } from "@lemma/tools";
import { startIsolate } from "./isolate.ts";

/**
 * Tools whose code runs in a worker thread, apart from the host (`tools.mjs`, which the host never imports). A tool
 * stuck in an endless loop does not stall the host: a call that does not answer in time stops the worker, and the
 * next call starts another. A cancelled turn stops it too. Turning the plugin off, or a reload, closes the worker, and
 * with it everything the module loaded, which code imported into the host would keep.
 *
 * A folder plugin, written the way a user writes one: link or copy the folder into `~/.lemma/plugins/`, and put your
 * own tools in `tools.mjs`. The pattern holds for any registration the host can stand in for; a tool is the simplest.
 */

const Config = Schema.Struct({
  timeoutMs: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 30_000))).annotate({
    title: "Time a call may take",
    description: "In milliseconds; a call that takes longer stops the tools' worker.",
  }),
  memoryMb: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 256))).annotate({
    title: "Memory the tools may use",
    description: "The worker's heap in megabytes; past it the worker stops, not the host.",
  }),
});

/** Any input, checked by the tool itself, which the model is shown as the tool's JSON Schema (as MCP's tools are). */
const inputOf = (parameters: unknown) => Schema.Unknown.check(Schema.makeFilter(() => true, { toJsonSchema: () => parameters as Record<string, unknown> }));

/** The plugin, running `module`'s tools (the folder's `tools.mjs` unless told another). */
export const makeIsolated = (module = new URL("./tools.mjs", import.meta.url), id = "isolated") =>
  definePlugin({
    id,
    version: "0.1.0",
    uses: ["lemma/tools@1"],
    config: Config,
    setup: async (_deps, { add, config, onCleanup }) => {
      const isolate = startIsolate(module, config);
      onCleanup(() => isolate.close());
      for (const tool of await isolate.list()) {
        add(Tools, {
          name: tool.name,
          description: tool.description,
          input: inputOf(tool.parameters),
          execute: async (input, { signal }) => new ToolResult({ content: [{ type: "text", text: await isolate.call(tool.name, input, signal) }] }),
        });
      }
    },
  });

export default makeIsolated();
