import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Hook, Registry, schemaCheck } from "@lemma/core";
import type { Awaitable } from "@lemma/core";
import { ImageContent, TextContent, ToolSpec } from "@lemma/llm";
import type { JsonSchema } from "@lemma/llm";
import type { ResultCredit } from "@lemma/contracts";

export class ToolResult extends Schema.Class<ToolResult>("lemma/ToolResult")({
  content: Schema.Array(Schema.Union([TextContent, ImageContent])),
  isError: Schema.optional(Schema.Boolean),
  /** Structured data for UIs (diffs, exit codes); logged, never sent to the model. */
  details: Schema.optional(Schema.Unknown),
  /**
   * What the call resolves to in a script of a tool that runs others (`codemode`), of the shape the tool's `output`
   * declares: a command's whole output and exit code, an image as a block. Neither logged nor sent to the model, so it
   * may hold more than `content` (a megabyte of output the model would see the tail of).
   */
  structured: Schema.optional(Schema.Unknown),
}) {}

/**
 * An image as a script holds it: what `read` resolves to for an image, what a screenshot is, and what a script hands to
 * a classifier or shows with `image()`. `data` is base64.
 */
export const ImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
  /** What goes with it, as the model would read it: a size, a resize. */
  note: Schema.optional(Schema.String),
});
export type ImageBlock = typeof ImageBlock.Type;

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
  /**
   * `true`: only a tool that runs others (`nests`) calls it, so the model is not sent its declaration. A plugin with many
   * tools (an MCP server's) keeps every request's tool list short and unchanged as they come and go, and a script finds
   * them by searching. A request still offers it (`ToolInvocation.offered`), and one offering no tool that runs others
   * declares it after all, as nothing else would call it (`declaredTools`). Not with `direct`.
   */
  readonly nested?: true;
  /** `true`: it runs other tools (`codemode`), so a request offering it leaves the `nested` ones for it to call. */
  readonly nests?: true;
  /**
   * The shape of its results' `structured`, which a script's call resolves to instead of the result's text, and which
   * the script's declaration of the tool names. A tool declaring one resolves on an error result too when it set
   * `structured` (a command that exited non-zero), so the script reads what happened. Absent: a call resolves to the
   * result's text, or `{ text, images }` when it has images, and an error result rejects.
   */
  readonly output?: Schema.Top;
  /**
   * The `ToolNamespaces` entry it belongs to (`browser`, an MCP server's): scripts search and list tools by it, and
   * read what the namespace says of them all at once.
   */
  readonly namespace?: string;
  /**
   * `true`: a call shows the person something beside the model's text (a page drawn in the chat), drawn from its
   * result, so a tool that runs others keeps each call of it that succeeds, its result and its input's `title`, in its
   * own result, for the chat to show as this tool's calls show.
   */
  readonly display?: true;
  readonly execute: (input: Input, context: ToolContext) => Awaitable<ToolResult, unknown>;
}

/**
 * A group of tools scripts reach together (`browser`, an MCP server's): what they are for, and how to use them, which a
 * script reads with `describeNamespace` instead of every request carrying it. Tools name theirs as `Tool.namespace`.
 */
export interface ToolNamespace {
  /** An identifier: letters, digits, `_`, `-`. */
  readonly name: string;
  /** What its tools are for, in a sentence; searching ranks its tools by it too. */
  readonly description: string;
  /** How to use its tools together, read on demand: the order calls go in, what a ref is. */
  readonly instructions?: string;
  /** Other names scripts may use for it (an MCP server's name as configured). */
  readonly aliases?: readonly string[];
}

export class ToolInvocation extends Schema.Class<ToolInvocation>("lemma/ToolInvocation")({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cwd: Schema.String,
  /**
   * The tools, by name, the model request behind this call offered (after `AgentRequestHook`): those it declared to
   * the model, and the `nested` ones a tool that runs others may call. The registry refuses any other as `NotFound`.
   * A call resumed after a restart is held to what its request offered, as logged. Absent: no request to hold it to,
   * as for a call made outside a turn.
   */
  offered: Schema.optional(Schema.Array(Schema.String)),
  /**
   * For the model's own call: the tools, by name, the request declared to it (`declaredTools`), the only ones it may
   * call; the rest of `offered` only a tool that runs others calls. Absent: a call a tool makes, or one made outside
   * a turn.
   */
  declared: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The session event the call's turn had reached when it was made (`ToolContext.leafId`). Absent: a call made outside
   * a turn.
   */
  leafId: Schema.optional(Schema.String),
}) {}

/**
 * Around every execution: timeouts, rewrites, logging. A handler that does not
 * call `next` skips the tool and supplies the result itself.
 *
 * @composition a chain around every call, then the guards, then the tool: a handler rewrites the call it hands
 * `next`, changes the result `next` returns, or answers without `next` (no guard or tool runs). A handler that fails
 * becomes an error result the model reads. Checked: what a handler hands on is a `ToolInvocation`, what it returns a
 * `ToolResult`.
 */
export const ToolExecuteHook = Hook.make<ToolInvocation, ToolResult, ToolError>("lemma/tool.execute", {
  check: { input: schemaCheck(ToolInvocation), output: schemaCheck(ToolResult) },
  summary: {
    input: (call) => ({ tool: call.name, call: call.toolCallId }),
    output: (result) => ({ error: result.isError === true, parts: result.content.length }),
  },
});

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
 *
 * @composition all tools, one per name (another plugin adding a name fails `Conflict`); a throw or failure from
 * `execute` becomes an error result the model reads. Checked when added: a name, a description, a Schema input, an
 * `execute` function.
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
    if (tool.direct === true && tool.nested === true)
      return `Tool "${tool.name}" cannot be both direct (only the model calls it) and nested (only tools call it)`;
    if (tool.output !== undefined && !Schema.isSchema(tool.output)) return `Tool "${tool.name}" has an output that is not a Schema`;
    if (tool.namespace !== undefined && typeof tool.namespace !== "string") return `Tool "${tool.name}" has a namespace that is not a name`;
    return typeof tool.execute === "function" ? undefined : `Tool "${tool.name}" needs an execute function`;
  },
});

/**
 * The namespaces tools belong to (`Tool.namespace`): `PluginContext.add(ToolNamespaces, namespace)`, by the plugin
 * adding the tools.
 *
 * @composition all namespaces, one per name (another plugin adding a name fails `Conflict`). Checked when added: a name
 * of letters, digits, `_` and `-`, a description, and instructions and aliases, when given, of text.
 */
export const ToolNamespaces = Registry.make<ToolNamespace>("lemma/tools.namespaces", {
  key: (namespace) => namespace.name,
  unique: true,
  check: (value) => {
    const namespace = value as Partial<ToolNamespace> | null;
    if (typeof namespace !== "object" || namespace === null) return "A namespace is an object";
    if (typeof namespace.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(namespace.name)) return "A namespace needs a name of letters, digits, _ and -";
    if (typeof namespace.description !== "string") return `Namespace "${namespace.name}" needs a description`;
    if (namespace.instructions !== undefined && typeof namespace.instructions !== "string")
      return `Namespace "${namespace.name}" has instructions that are not text`;
    if (namespace.aliases !== undefined && (!Array.isArray(namespace.aliases) || namespace.aliases.some((alias) => typeof alias !== "string")))
      return `Namespace "${namespace.name}" has aliases that are not a list of names`;
    return undefined;
  },
});

/**
 * The guards every call passes before its tool runs: `PluginContext.add(Guards, { tool, guard })`.
 *
 * @composition every guard for the call's tool and for `*` runs, and any `deny` wins; a guard that fails denies, so a
 * broken guard never lets a call through.
 */
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
  /** The tool's `nested`: the agent offers it to a request without declaring it to the model (`declaredTools`). */
  readonly nested?: true;
  /** The tool's `nests`. */
  readonly nests?: true;
  /** The tool's `output`, as JSON Schema: what a script's call resolves to. */
  readonly output?: JsonSchema;
  /** The tool's `namespace`. */
  readonly namespace?: string;
  /** The tool's `display`. */
  readonly display?: true;
}

/**
 * The tools of `tools`, a request's, that the model is sent the declarations of: all but the `nested` ones, unless no
 * tool that runs others (`nests`) is among them to call those.
 */
export const declaredTools = (tools: readonly ToolContribution[]): readonly ToolContribution[] =>
  tools.some((tool) => tool.nests === true && tool.nested !== true) ? tools.filter((tool) => tool.nested !== true) : tools;

export interface ExecuteOptions {
  /**
   * Where the call's live output goes instead of its own `ToolOutput`: a tool that runs others passes its
   * `ToolContext.update`, so their output shows as its own and ends with it. A listener: an Effect it returns
   * runs, and its failure (thrown, rejected, or failed) is logged, never the tool's. Its chunks reach it one at a time,
   * in order, each once the last one's Effect has ended, and a call that finishes returns only after they all have: a
   * slow listener slows the call, and one that never ends holds it. A call cut off (cancelled, interrupted) waits on none.
   */
  readonly update?: (chunk: string) => Awaitable<void, unknown>;
  /**
   * Hears who shaped the result, once it is settled: `ToolExecuteHook`'s handlers (each one's own time, and whether it
   * changed the call or the result, or answered itself), the guards' decisions, and the registry's cut. The agent logs it
   * with the result.
   */
  readonly credit?: (credit: ResultCredit) => void;
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
