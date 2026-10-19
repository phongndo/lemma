import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { ToolRunner, TOOLS_CONTRACT } from "@lemma/tools";
import { makeRegistry } from "./registry.ts";

const ToolsConfig = Schema.Struct({
  maxResultChars: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 100_000)))
    .annotate({
      description: "Total text characters one result may carry to the model; longer results are cut with a marker.",
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
