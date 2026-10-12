/** `@lemma/tools/testing`: calls a tool as the registry would, without a registry, for a tool's own tests. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { Tool, ToolContext, ToolResult } from "./tools.ts";

/** A call's context in `cwd`, with a signal nothing aborts unless given one. */
export const context = (cwd: string, signal: AbortSignal = new AbortController().signal): ToolContext => ({ sessionId: "s", toolCallId: "c", cwd, signal });

/** Calls a tool directly, decoding input with its schema as the registry would. */
export const call = async <I>(tool: Tool<I>, input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  const decoded = Schema.decodeUnknownSync(tool.input)(input);
  const output = tool.execute(decoded, ctx);
  return Effect.isEffect(output) ? Effect.runPromise(output as Effect.Effect<ToolResult>) : output;
};

/** Like `call`, but a throw becomes the message, as the registry reports it to the model. */
export const attempt = async <I>(tool: Tool<I>, input: unknown, ctx: ToolContext): Promise<string> =>
  call(tool, input, ctx).then(
    (result) => `ok: ${textOf(result)}`,
    (error: Error) => `error: ${error.message}`,
  );

/** A result's text, an image as `<image type>`. */
export const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === "text" ? part.text : `<image ${part.mimeType}>`)).join("\n");

/** A new, empty directory for a test to work in. */
export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "lemma-tools-"));
