import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { DEFAULT_MAX_RESULT_CHARS, ToolRunner, TOOLS_CONTRACT } from "@lemma/tools";
import { makeRegistry } from "./registry.ts";

const ToolsConfig = Schema.Struct({
  maxResultChars: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => DEFAULT_MAX_RESULT_CHARS)))
    .annotate({
      description:
        "Text characters one result carries to the model, every tool's output bounded by it; longer text keeps its start and its end, the whole in a temp file.",
    }),
});
type ToolsConfig = typeof ToolsConfig.Type;

export { toolParameters } from "./schema.ts";

export default definePlugin({
  id: "tools.registry",
  implements: [TOOLS_CONTRACT],
  version: "0.1.0",
  config: ToolsConfig,
  provides: { tools: ToolRunner },
  setup: (_, { config }) => Effect.map(makeRegistry(config), (tools) => ({ tools })),
});
