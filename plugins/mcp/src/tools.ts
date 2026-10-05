import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ToolResult } from "@lemma/contracts";
import type { McpToolHints, Tool, ToolContext } from "@lemma/contracts";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { Connection } from "./connection.ts";
import { errorMessage, isUnauthorized } from "./connection.ts";
import { toToolResult } from "./content.ts";
import { inputParameters, inputSchema } from "./schema.ts";

/** Claude Code's cap on an MCP tool's description: servers that write essays still cost a bounded amount. */
const MAX_DESCRIPTION = 2_048;
/** Room left under the registry's cap for the truncation note. */
const RESERVED_CHARS = 1_000;
/** No call outlives this, however much progress the server reports. */
const MAX_TOTAL_MS = 60 * 60 * 1_000;

/** What the model reads as a tool's description: its title, then its description, cut at 2,048 characters. */
export function describe(tool: McpTool): string {
  const title = tool.title ?? tool.annotations?.title;
  const text = [title !== undefined && title !== tool.name ? `${title}.` : "", tool.description ?? ""].filter(Boolean).join(" ").trim();
  const full = text === "" ? `The ${tool.name} tool.` : text;
  return full.length > MAX_DESCRIPTION ? `${full.slice(0, MAX_DESCRIPTION - 1)}…` : full;
}

export const hintsOf = (tool: McpTool): McpToolHints => {
  const annotations = tool.annotations ?? {};
  return {
    ...(annotations.readOnlyHint === undefined ? {} : { readOnly: annotations.readOnlyHint }),
    ...(annotations.destructiveHint === undefined ? {} : { destructive: annotations.destructiveHint }),
    ...(annotations.idempotentHint === undefined ? {} : { idempotent: annotations.idempotentHint }),
    ...(annotations.openWorldHint === undefined ? {} : { openWorld: annotations.openWorldHint }),
  };
};

export interface ToolOptions {
  readonly server: string;
  /** The model's name for it. */
  readonly name: string;
  readonly definition: McpTool;
  readonly connection: Connection;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
}

/**
 * An MCP tool as a registry tool. Its input is described by the server's
 * schema and validated by the server; a read-only tool is safe to repeat
 * after a restart (`replay`). Its output is typed by the server's output
 * schema, `unknown` without one (see `scriptValue`). Progress the server
 * reports streams as the call's output and keeps the call alive.
 */
export function mcpTool(options: ToolOptions): Tool<Record<string, unknown>> {
  const { connection, definition, server } = options;
  return {
    name: options.name,
    description: describe(definition),
    input: inputSchema(definition.inputSchema) as unknown as Schema.Schema<Record<string, unknown>, any, never>,
    outputSchema: definition.outputSchema === undefined ? {} : inputParameters(definition.outputSchema),
    ...(definition.annotations?.readOnlyHint === true ? { replay: "safe" as const } : {}),
    execute: async (input, context) => {
      let result;
      try {
        result = await connection.callTool(definition.name, input, {
          signal: context.signal,
          timeoutMs: options.timeoutMs,
          maxTotalMs: MAX_TOTAL_MS,
          ...(context.update === undefined ? {} : { onProgress: context.update }),
        });
      } catch (error) {
        throw new Error(callFailure(server, definition.name, error, options.timeoutMs));
      }
      return capOutput(toToolResult(result, { server, tool: definition.name }), budget(options.maxOutputChars, context));
    },
  };
}

const budget = (maxOutputChars: number, context: Pick<ToolContext, "maxResultChars">) =>
  Math.max(1_000, Math.min(maxOutputChars, (context.maxResultChars ?? Number.POSITIVE_INFINITY) - RESERVED_CHARS));

/** Why a call failed, as the model reads it. */
export function callFailure(server: string, tool: string, error: unknown, timeoutMs: number): string {
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return `MCP server "${server}" did not finish ${tool} in time (it may wait ${Math.round(timeoutMs / 1000)}s without reporting progress)`;
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) return `MCP server "${server}" disconnected during ${tool}`;
  if (isUnauthorized(error)) return `MCP server "${server}" needs the user to sign in again (Settings → MCP servers, or \`lemma mcp login ${server}\`)`;
  return errorMessage(error);
}

/**
 * Text past `budget` characters becomes its start and end with a note, and
 * the whole text goes to a temp file the model can read, as codemode does;
 * images are kept.
 */
export async function capOutput(result: ToolResult, budget: number): Promise<ToolResult> {
  const texts = result.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
  const combined = texts.join("\n");
  if (combined.length <= budget) return result;
  const head = combined.slice(0, Math.floor(budget / 2));
  const tail = combined.slice(combined.length - Math.ceil(budget / 2));
  const path = join(tmpdir(), `lemma-mcp-${randomBytes(8).toString("hex")}.txt`);
  let where: string;
  try {
    await writeFile(path, combined);
    where = `the whole output is in ${path} (read it with offset/limit)`;
  } catch (error) {
    where = `the whole output could not be saved: ${errorMessage(error)}`;
  }
  const text = `${head}\n\n[… ${combined.length - head.length - tail.length} characters cut; ${where} …]\n\n${tail}`;
  return new ToolResult({
    ...result,
    content: [{ type: "text", text }, ...result.content.filter((item) => item.type === "image")],
    details: { ...(typeof result.details === "object" && result.details !== null ? result.details : {}), fullOutputPath: path },
  });
}
