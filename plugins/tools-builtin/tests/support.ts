import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import type { Tool, ToolContext, ToolResult } from "@lemma/tools";

export const context = (cwd: string, signal: AbortSignal = new AbortController().signal): ToolContext => ({ sessionId: "s", toolCallId: "c", cwd, signal });

/** Calls a tool directly, decoding input with its schema as the registry would. */
export const call = async <I>(tool: Tool<I>, input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  const { Schema } = await import("effect");
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

export const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === "text" ? part.text : `<image ${part.mimeType}>`)).join("\n");

export const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "lemma-tools-"));
