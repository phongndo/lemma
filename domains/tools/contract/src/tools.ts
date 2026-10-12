import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Hook, Registry } from "@lemma/core";
import type { Awaitable } from "@lemma/core";
import { ImageContent, TextContent, ToolSpec } from "@lemma/llm";

export class ToolResult extends Schema.Class<ToolResult>("lemma/ToolResult")({
  content: Schema.Array(Schema.Union([TextContent, ImageContent])),
  isError: Schema.optional(Schema.Boolean),
  /** Structured data for UIs (diffs, exit codes); logged, never sent to the model. */
  details: Schema.optional(Schema.Unknown),
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
  /**
   * The session event the call's turn had reached: `Sessions.branch(sessionId, { leaf: leafId })` is the branch the call
   * is on, whatever a checkout during the turn did to the session's leaf. A tool keeping its state in its results reads
   * it from there.
   */
  readonly leafId?: string;
  /** Text characters a result keeps before the registry cuts it; a tool that truncates its own output fits under it. */
  readonly maxResultChars?: number;
}

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly tool: string;
  readonly reason: "NotFound" | "InvalidInput" | "Failed" | "Cancelled";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A tool a plugin adds to `Tools`. `execute` returns its result, a promise of
 * it, or an Effect (`Awaitable`): a plugin written with promises or with
 * Effects adds one alike. A thrown or failed execution becomes an `isError`
 * result for the model.
 */
export interface Tool<Input = any> {
  readonly name: string;
  /** Model-facing description. */
  readonly description: string;
  readonly input: Schema.Codec<Input, any>;
  /**
   * `safe`: running it again with the same input does no harm (it only reads), so a call cut off by a host restart is
   * run again. Absent: a cut-off call is not repeated, and the model is told it was interrupted, with its output so far.
   */
  readonly replay?: "safe";
  /**
   * `safe`: it may run at the same time as other calls of one response that are `safe` too (it only reads), so the agent
   * runs a run of consecutive such calls together. Absent: its calls run one at a time, in order.
   */
  readonly parallel?: "safe";
  /**
   * `true`: only the model calls it, never a tool that runs others (`codemode`). Its result is then logged as its own,
   * which a tool keeping its state in its results' `details` needs: a nested call's result is the outer tool's to keep.
   */
  readonly direct?: true;
  readonly execute: (input: Input, context: ToolContext) => Awaitable<ToolResult, unknown>;
}

export class ToolInvocation extends Schema.Class<ToolInvocation>("lemma/ToolInvocation")({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cwd: Schema.String,
  /**
   * The tools, by name, the model request behind this call offered (after `AgentRequestHook`); the registry refuses
   * any other as `NotFound`. Absent: no request to hold it to, as for a call resumed after a restart.
   */
  offered: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The session event the call's turn had reached when it was made (`ToolContext.leafId`). Absent: a call made outside
   * a turn.
   */
  leafId: Schema.optional(Schema.String),
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
/** Returns its decision, a promise of it, or an Effect (`Awaitable`), so a plugin written with promises can guard too. */
export type Guard = (invocation: ToolInvocation) => Awaitable<GuardDecision, ToolError>;

/** A guard a plugin adds to `Guards`, for the calls of one tool. */
export interface ToolGuard {
  /** The tool's name, or `*` for every tool. */
  readonly tool: string;
  readonly guard: Guard;
}

/**
 * The tools the model may call: `PluginContext.add(Tools, tool)`. A tool belongs to the plugin that added it, which its
 * calls are attributed to, and leaves with it; a name is one plugin's at a time (another adding it fails `Conflict`),
 * and a plugin's replacement takes over its names. `ToolRunner` lists and runs them.
 */
export const Tools = Registry.make<Tool>("lemma/tools", {
  key: (tool) => tool.name,
  unique: true,
  check: (value) => {
    const tool = value as Partial<Tool> | null;
    if (typeof tool !== "object" || tool === null) return "A tool is an object";
    if (typeof tool.name !== "string" || tool.name === "") return "A tool needs a name";
    if (typeof tool.description !== "string") return `Tool "${tool.name}" needs a description`;
    if (!Schema.isSchema(tool.input)) return `Tool "${tool.name}" needs an input Schema`;
    return typeof tool.execute === "function" ? undefined : `Tool "${tool.name}" needs an execute function`;
  },
});

/** The guards every call passes before its tool runs: `PluginContext.add(Guards, { tool, guard })`. */
export const Guards = Registry.make<ToolGuard>("lemma/tools.guards", {
  check: (value) => {
    const item = value as Partial<ToolGuard> | null;
    return typeof item?.tool === "string" && typeof item.guard === "function" ? undefined : "A guard is { tool: string, guard: (call) => decision }";
  },
});

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

/** A tool's model-facing spec and the plugin that added it. */
export interface ToolContribution {
  readonly spec: ToolSpec;
  readonly source: string;
  /** The tool's `replay`. */
  readonly replay?: "safe";
  /** The tool's `parallel`. */
  readonly parallel?: "safe";
  /** The tool's `direct`. */
  readonly direct?: true;
}

export interface ExecuteOptions {
  /**
   * Where the call's live output goes instead of its own `ToolOutput`: a tool that runs others passes its
   * `ToolContext.update`, so their output shows as its own and ends with it. A listener: an Effect it returns
   * runs, and its failure (thrown, rejected, or failed) is logged, never the tool's.
   */
  readonly update?: (chunk: string) => Awaitable<void, unknown>;
}

/** Lists and runs what `Tools` holds: the agent, and a tool that runs others, call it. */
export class ToolRunner extends Context.Service<
  ToolRunner,
  {
    /** By name. */
    readonly list: Effect.Effect<readonly ToolContribution[]>;
    /**
     * Validates input, runs `ToolExecuteHook`, guards, then the tool. Tool
     * failures and denials become `isError` results; only unknown tools
     * (`NotFound`), an aborted `signal` (`Cancelled`, which interrupts the tool
     * and publishes no `ToolExecuted`), and interruption escape as failures.
     */
    readonly execute: (invocation: ToolInvocation, signal: AbortSignal, options?: ExecuteOptions) => Effect.Effect<ToolResult, ToolError>;
  }
>()("lemma/ToolRunner") {}
