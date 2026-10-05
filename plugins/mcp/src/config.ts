import { Schema } from "effect";
import { McpServerSpec } from "@lemma/contracts";

const milliseconds = Schema.Number.pipe(Schema.int(), Schema.positive());

export const McpConfig = Schema.Struct({
  servers: Schema.optionalWith(Schema.Array(McpServerSpec), { default: () => [] }).annotations({
    description: "The MCP servers to connect to. Edit them in Settings → MCP servers or with `lemma mcp`; see the plugin's README for the fields.",
  }),
  startupTimeoutMs: Schema.optionalWith(milliseconds, { default: () => 30_000 }).annotations({
    description: "How long connecting to a server may take, in milliseconds.",
  }),
  toolTimeoutMs: Schema.optionalWith(milliseconds, { default: () => 300_000 }).annotations({
    description: "How long a tool call may go without a result or reported progress, in milliseconds.",
  }),
  startupWaitMs: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.nonNegative()), { default: () => 10_000 }).annotations({
    description: "How long the first model request waits for servers still making their first connection, in milliseconds.",
  }),
  maxOutputChars: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), { default: () => 40_000 }).annotations({
    description: "Text characters of a tool result the model reads; past it the middle is cut and the whole text saved to a file the model can read.",
  }),
});
export type McpConfig = typeof McpConfig.Type;
