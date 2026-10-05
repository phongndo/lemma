import { Context, Data, Schema } from "effect";
import type { Effect, Scope } from "effect";
import { Event, Hook } from "@lemma/core";
import type { PluginContext } from "@lemma/core";
import { ImageContent, TextContent, ToolSpec } from "./llm.ts";
import type { JsonSchema } from "./llm.ts";

export class ToolResult extends Schema.Class<ToolResult>("lemma/ToolResult")({
  content: Schema.Array(Schema.Union(TextContent, ImageContent)),
  isError: Schema.optional(Schema.Boolean),
  /** Structured data for UIs (diffs, exit codes); logged, never sent to the model. */
  details: Schema.optional(Schema.Unknown),
  /**
   * The result as data, shaped as the tool's `outputSchema` says: what a call from a codemode script resolves to, error
   * results included. Logged, never sent to the model.
   */
  structuredContent: Schema.optional(Schema.Unknown),
}) {}

export interface ToolContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  /** Aborted when the turn is cancelled. Promise-based tools must honor it; Effect tools are interrupted. */
  readonly signal: AbortSignal;
  /**
   * Reports output as it is produced (a command's stdout), for UIs to show
   * while the tool runs. Chunks append; the model reads only the result.
   */
  readonly update?: (chunk: string) => void;
  /** The call's `ToolInvocation.offered`: a tool that runs others offers only these. */
  readonly offered?: readonly string[];
  /** Text characters a result keeps before the registry cuts it; a tool that truncates its own output fits under it. */
  readonly maxResultChars?: number;
}

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly tool: string;
  readonly reason: "NotFound" | "InvalidInput" | "Failed" | "Denied" | "Cancelled";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A tool as registered by a plugin. `execute` may return a Promise or an
 * Effect; the tools plugin adapts promises once at registration. A thrown or
 * failed execution becomes an `isError` result for the model.
 */
export interface Tool<Input = any> {
  readonly name: string;
  /** Model-facing description. */
  readonly description: string;
  readonly input: Schema.Schema<Input, any, never>;
  /**
   * `safe`: running it again with the same input does no harm (it only reads), so a call cut off by a host restart is
   * run again. Absent: a cut-off call is not repeated, and the model is told it was interrupted, with its output so far.
   */
  readonly replay?: "safe";
  /**
   * JSON Schema of the `structuredContent` its results carry. A codemode script's call resolves to that data, typed by
   * this; without it, to the result's text.
   */
  readonly outputSchema?: JsonSchema;
  readonly execute: (input: Input, context: ToolContext) => Promise<ToolResult> | Effect.Effect<ToolResult, unknown>;
}

export class ToolInvocation extends Schema.Class<ToolInvocation>("lemma/ToolInvocation")({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cwd: Schema.String,
  /**
   * The tools, by name, the model request behind this call offered (after `AgentRequestHook`): those it declared to
   * the model and those it left reachable (`RequestDraft.reachable`). The registry refuses any other as `NotFound`.
   * Absent: no request to hold it to, as for a call resumed after a restart.
   */
  offered: Schema.optional(Schema.Array(Schema.String)),
}) {}

/**
 * Around every execution: timeouts, rewrites, logging. A handler that does not
 * call `next` skips the tool and supplies the result itself.
 */
export const ToolExecuteHook = Hook.make<ToolInvocation, ToolResult, ToolError>("lemma/tool.execute");

/**
 * A guard decides whether a call may run. Guards run inside the terminal of
 * `ToolExecuteHook`, after every handler has shaped the input and just before
 * the tool, so no hook ordering can route around one. Any `deny` wins; the
 * model receives the reason as an error result. No guard ships by default.
 */
export type GuardDecision = { readonly _tag: "allow" } | { readonly _tag: "deny"; readonly reason: string };
export type Guard = (invocation: ToolInvocation) => Effect.Effect<GuardDecision, ToolError>;

export const ToolExecuted = Event.make<{
  readonly invocation: ToolInvocation;
  readonly result: ToolResult;
  readonly durationMs: number;
}>("lemma/tool.executed");

/**
 * Live output of a running tool (see `ToolContext.update`), batched; the durable record is its result. Losable.
 * `offset` is how much the tool had printed before `chunk` (a batch keeps only its tail, so offsets can skip).
 */
export const ToolOutput = Event.make<{
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly chunk: string;
  readonly offset: number;
}>("lemma/tool.output");

/** A registered tool's model-facing spec and the plugin that registered it. */
export interface ToolContribution {
  readonly spec: ToolSpec;
  readonly source: string;
  /** The tool's `replay`. */
  readonly replay?: "safe";
  /** The tool's `outputSchema`. */
  readonly outputSchema?: JsonSchema;
}

export interface ExecuteOptions {
  /**
   * Where the call's live output goes instead of its own `ToolOutput`: a tool that runs others passes its
   * `ToolContext.update`, so their output shows as its own and ends with it.
   */
  readonly update?: (chunk: string) => void;
}

export class Tools extends Context.Tag("lemma/Tools")<
  Tools,
  {
    /**
     * Call during activation: the registering plugin's `PluginContext` supplies
     * the provenance id. Removed when that plugin's scope closes. A duplicate
     * name fails with `InvalidInput`.
     */
    readonly register: <I>(tool: Tool<I>) => Effect.Effect<void, ToolError, Scope.Scope | PluginContext>;
    readonly guard: (name: string, guard: Guard) => Effect.Effect<void, never, Scope.Scope | PluginContext>;
    readonly list: Effect.Effect<readonly ToolContribution[]>;
    /**
     * Validates input, runs `ToolExecuteHook`, guards, then the tool. Tool
     * failures and denials become `isError` results; only unknown tools
     * (`NotFound`), an aborted `signal` (`Cancelled`, which interrupts the tool
     * and publishes no `ToolExecuted`), and interruption escape as failures.
     */
    readonly execute: (invocation: ToolInvocation, signal: AbortSignal, options?: ExecuteOptions) => Effect.Effect<ToolResult, ToolError>;
  }
>() {}
