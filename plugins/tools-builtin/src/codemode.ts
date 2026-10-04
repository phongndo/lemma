// Adapted from pi (MIT): packages/coding-agent/src/extensions/codemode/{tool,execute}.ts.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemodeSandbox, parseCodemodeSource, renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import type { CodemodeCall, CodemodeError, CodemodeTool } from "@earendil-works/pi-codemode";
import { Effect, Either, Runtime, Schema } from "effect";
import type { Context } from "effect";
import { contentText, ToolInvocation, ToolResult } from "@lemma/contracts";
import type { Tool, Tools } from "@lemma/contracts";

export const CodemodeInput = Schema.Struct({
  code: Schema.String.annotations({ description: "Raw JavaScript source." }),
});
export type CodemodeInput = typeof CodemodeInput.Type;

export interface CodemodeDetails {
  /** Every nested call, in call order; one still running when the script ended is `cancelled`. */
  readonly calls: readonly CodemodeCall[];
  readonly truncated?: true;
  /** The complete text output, when it was truncated. */
  readonly fullOutputPath?: string;
}

type Content = ToolResult["content"][number];

/**
 * The VM's heap. The sandbox runs in a worker of the host's process, so a runaway script must
 * not grow to wasm32's 4 GiB; past this it fails inside the script with `InternalError: out of memory`.
 */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Output budget without a `max_output_tokens` option. */
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
/** Room for the result's header and truncation notes, so output cut here still fits the registry's cap whole. */
const RESERVED_CHARS = 1_000;
/** What a nested call resolves to: its text, since Lemma's tools declare no output schema. */
const TEXT_OUTPUT = { type: "string" };
/** Results of `searchTools` without a `limit`. */
const SEARCH_LIMIT = 8;

/**
 * pi's description with the tools all directly callable, as pi's default mode has them: their
 * declarations are the model's own tool list, so they are not repeated here.
 */
const DESCRIPTION = `Run JavaScript that calls other tools. The code is raw JavaScript (no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` calls any of your other tools with the same arguments (characters not valid in identifiers become \`_\`). It resolves to the tool's text output as a string and rejects with an Error on failure. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`. Without \`timeout_ms\`, a script stops after 300 seconds.

Globals:
- \`text(value)\`, \`image(dataUrlOrImageBlock)\`, \`console.log(...)\`, and top-level \`return\` add output; \`exit()\` ends the script.
- \`ALL_TOOLS\` and \`searchTools(query, { limit? })\` list \`{ name, description }\` of callable tools, each description ending in the tool's TypeScript declaration.

Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.`;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
const valueText = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

const words = (text: string): ReadonlySet<string> => new Set(text.toLowerCase().match(/[a-z0-9]+/g));

/**
 * `searchTools(query, { limit? })`, which the sandbox's own errors point to: tools ranked by the
 * query words their name (weighted) and description contain. pi ranks with BM25; a handful of
 * tools does not need it.
 */
const searchTools = (tools: readonly CodemodeTool[]): CodemodeTool => ({
  name: "searchTools",
  spread: true,
  execute: (args) => {
    // Spread arguments cross the sandbox as a JSON array, so a missing one arrives as null.
    const [query, options] = args as [unknown, { readonly limit?: unknown } | null | undefined];
    if (typeof query !== "string") throw new Error("searchTools() expects a query string");
    const limit = options?.limit ?? SEARCH_LIMIT;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("searchTools() limit must be a positive integer");
    const terms = [...words(query)];
    const score = (tool: CodemodeTool) => {
      const name = words(tool.name);
      const description = words(tool.description ?? "");
      return terms.reduce((sum, term) => sum + (name.has(term) ? 3 : 0) + (description.has(term) ? 1 : 0), 0);
    };
    return tools
      .map((tool) => ({ tool, score: score(tool) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ tool }) => ({ name: toCodemodeIdentifier(tool.name), description: tool.description }));
  },
});

function formatError(error: CodemodeError, calls: readonly CodemodeCall[]): string {
  const head =
    error.kind === "script"
      ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  const summary =
    calls.length === 0
      ? "No tool calls were made."
      : `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
  return `${head}\n\n${summary}`;
}

/**
 * Over the budget (in characters), the text items become one that keeps the start and end of the
 * text, with the images after it, and the whole text goes to a temp file the model can read.
 */
async function truncateOutput(items: readonly Content[], budget: number): Promise<{ readonly content: readonly Content[]; readonly fullOutputPath?: string }> {
  const combined = items.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  if (combined.length <= budget) return { content: items };
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - budget;
  const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
  let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${combined.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
  const path = join(tmpdir(), `lemma-codemode-${randomBytes(8).toString("hex")}.txt`);
  let saved = true;
  try {
    await writeFile(path, combined);
    text += `\n\n[Full output: ${path} (read with offset/limit)]`;
  } catch (cause) {
    saved = false;
    text += `\n\n[Could not save the full output: ${cause instanceof Error ? cause.message : String(cause)}]`;
  }
  const content = [{ type: "text" as const, text }, ...items.filter((item) => item.type === "image")];
  return saved ? { content, fullOutputPath: path } : { content };
}

/**
 * Nested calls go through the live registry, as the agent's own calls do, so hooks and guards
 * apply to them, and in this call's fiber context, so they keep its interaction origin and trace.
 * A script reaches only the tools the request offered, read per script, and never codemode. Their
 * live output is this call's own.
 */
export const codemodeTool = (registry: Context.Tag.Service<typeof Tools>): Tool<CodemodeInput> => ({
  name: "codemode",
  description: DESCRIPTION,
  input: CodemodeInput,
  // No `replay`: a script may write files or run commands, so one cut off by a host restart is not run again.
  execute: (input, { sessionId, toolCallId, cwd, signal, update, offered, maxResultChars }) =>
    Effect.gen(function* () {
      const started = performance.now();
      const { code, options } = yield* Effect.try({ try: () => parseCodemodeSource(input.code), catch: (cause) => cause });
      const runtime = yield* Effect.runtime<never>();
      const listed = yield* registry.list;
      let count = 0;
      const tools = listed
        .filter(({ spec }) => spec.name !== "codemode" && (offered === undefined || offered.includes(spec.name)))
        .map(({ spec }): CodemodeTool => ({
          name: spec.name,
          // `ALL_TOOLS` entries carry the declaration.
          description: renderToolSample({ name: spec.name, description: spec.description, inputSchema: spec.parameters, outputSchema: TEXT_OUTPUT }),
          // The sandbox aborts `call.signal` when the script ends, times out, or is aborted.
          execute: async (args, call) => {
            const invocation = new ToolInvocation({
              sessionId,
              toolCallId: `${toolCallId}/${++count}`,
              name: spec.name,
              input: args,
              cwd,
              ...(offered === undefined ? {} : { offered }),
            });
            const outcome = await Runtime.runPromise(runtime)(Effect.either(registry.execute(invocation, call.signal, { update: update ?? (() => {}) })));
            if (Either.isLeft(outcome)) throw new Error(outcome.left.message);
            const text = contentText(outcome.right.content);
            if (outcome.right.isError) throw new Error(text || `Tool "${spec.name}" failed`);
            return text;
          },
        }));
      const sandbox = new CodemodeSandbox({
        tools,
        globals: [searchTools(tools)],
        // Without `timeout_ms`, the sandbox's own deadline.
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        memoryLimitBytes: MEMORY_LIMIT_BYTES,
      });
      const result = yield* Effect.tryPromise({ try: () => sandbox.execute(code, { signal }), catch: (cause) => cause }).pipe(
        Effect.ensuring(Effect.promise(() => sandbox.close().catch(() => {}))),
      );

      const items: Content[] = [...result.output];
      if (result.ok && result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
      if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result.error, result.calls)}` });
      const budget = Math.min(
        (options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * CHARS_PER_TOKEN,
        Math.max(0, (maxResultChars ?? Number.POSITIVE_INFINITY) - RESERVED_CHARS),
      );
      const { content, fullOutputPath } = yield* Effect.promise(() => truncateOutput(items, budget));
      const wallTime = ((performance.now() - started) / 1000).toFixed(1);
      const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
      const details: CodemodeDetails = { calls: result.calls, ...(fullOutputPath === undefined ? {} : { truncated: true, fullOutputPath }) };
      return new ToolResult({ content: [{ type: "text", text: header }, ...content], ...(result.ok ? {} : { isError: true }), details });
    }),
});
