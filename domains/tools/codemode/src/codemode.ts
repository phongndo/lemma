// Adapted from pi (MIT): packages/coding-agent/src/extensions/codemode/{tool,execute}.ts.
import { CodemodeSandbox, parseCodemodeSource, renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import type { CodemodeCall, CodemodeError, CodemodeTool } from "@earendil-works/pi-codemode";
import { Effect, Result, Schema } from "effect";
import type { Context } from "effect";
import { addUsage, ClassifierContext, contentText } from "@lemma/llm";
import type { Llm, Usage } from "@lemma/llm";
import { ToolInvocation, ToolResult } from "@lemma/tools";
import { boundOutput } from "@lemma/tools/files";
import type { Tool, ToolRunner } from "@lemma/tools";

export const CodemodeInput = Schema.Struct({
  code: Schema.String.annotate({ description: "Raw JavaScript source." }),
});
export type CodemodeInput = typeof CodemodeInput.Type;

export interface CodemodeDetails {
  /** Every nested call, in call order; one still running when the script ended is `cancelled`. */
  readonly calls: readonly CodemodeCall[];
  readonly truncated?: true;
  /** The complete text output, when it was truncated. */
  readonly fullOutputPath?: string;
  /** What the script's `models.classify` calls used, when their services reported it. */
  readonly usage?: Usage;
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
/** What a nested call resolves to: its text, since Lemma's tools declare no output schema. */
const TEXT_OUTPUT = { type: "string" };
/** Results of `searchTools` without a `limit`. */
const SEARCH_LIMIT = 8;
/** `models.classify` calls one script has in flight; `Promise.all` over many items queues the rest. */
const MAX_MODEL_CALLS = 4;

/**
 * pi's description with the tools all directly callable, as pi's default mode has them: their
 * declarations are the model's own tool list, so they are not repeated here. Tools only scripts
 * call (`nested`) are found by searching, so the description stays the same as they come and go.
 */
const DESCRIPTION = `Run JavaScript that calls other tools. The code is raw JavaScript (no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` calls any of your other tools with the same arguments (characters not valid in identifiers become \`_\`). It resolves to the tool's text output as a string and rejects with an Error on failure. Calls still running when the script ends are cancelled.
- Some tools are not in your tool list: only scripts call them. Find them with \`await searchTools(query)\` before calling one.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`. Without \`timeout_ms\`, a script stops after 300 seconds.

Globals:
- \`text(value)\`, \`image(dataUrlOrImageBlock)\`, \`console.log(...)\`, and top-level \`return\` add output; \`exit()\` ends the script.
- \`ALL_TOOLS\` and \`searchTools(query, { limit? })\` list \`{ name, description }\` of callable tools, each description ending in the tool's TypeScript declaration.
- \`await models.classifiers({ available: true })\` lists classifier models (\`{ ref, name, input, ... }\`): not chat models, but ones that answer typed questions about JSON state with probabilities, cheaply and in parallel, such as \`typesafe/jev-latest\`. \`await models.classify(ref, { state, images?, questions })\` asks one: \`questions\` maps ids to \`{ type: "choice", instructions, criteria: { <label>: <meaning> } }\`, \`{ type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] }\`, or \`{ type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } }\`. It resolves to \`{ answers, stopReason, errorMessage? }\`, answers by id: \`{ choice, probabilities, confidence }\`, \`{ score, confidence }\` (the expected level index), or \`{ probability }\` (of true). It does not throw on a provider's failure: check \`stopReason === "stop"\`. Classify many items with one call each.

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

const decodeClassifierContext = Schema.decodeUnknownResult(ClassifierContext);

/** Runs at most `limit` calls at once, in call order. */
const limiter = (limit: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await run();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
};

/**
 * `models.*`: the classifier models `Llm` lists, and `classify` through it with the session's credentials. A script
 * names a model by ref (or passes a listed entry), and a context it gets wrong fails with the shape expected, not a
 * provider's error. What the calls used goes to `addUsage`.
 */
const modelGlobals = (
  llm: Context.Service.Shape<typeof Llm>,
  run: <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>,
  addUsage: (usage: Usage) => void,
): CodemodeTool[] => {
  const limit = limiter(MAX_MODEL_CALLS);
  return [
    {
      name: "models.classifiers",
      spread: true,
      execute: (args) => {
        const [options] = args as [{ readonly available?: unknown } | null | undefined];
        return run(llm.classifiers({ available: options?.available === true }));
      },
    },
    {
      name: "models.classify",
      spread: true,
      execute: async (args, call) => {
        const [model, context] = args as [unknown, unknown];
        const ref = typeof model === "string" ? model : (model as { readonly ref?: unknown } | null)?.ref;
        if (typeof ref !== "string") {
          throw new Error(
            'models.classify() expects a classifier ref such as "typesafe/jev-latest" first; list them with models.classifiers({ available: true })',
          );
        }
        const decoded = decodeClassifierContext(context);
        if (Result.isFailure(decoded)) throw new Error(`models.classify() got a context it cannot use: ${decoded.failure.message}`);
        // The sandbox aborts the call's signal when the script ends, times out, or is aborted; that interrupts the request.
        const result = await limit(() => run(llm.classify(ref, decoded.success), call.signal));
        if (result.usage !== undefined) addUsage(result.usage);
        return result;
      },
    },
  ];
};

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
 * Nested calls go through the live registry, as the agent's own calls do, so hooks and guards
 * apply to them, and in this call's fiber context, so they keep its interaction origin and trace.
 * A script reaches only the tools the request offered, read per script, and never codemode. Their
 * live output is this call's own.
 */
export const codemodeTool = (registry: Context.Service.Shape<typeof ToolRunner>, llm: Context.Service.Shape<typeof Llm>): Tool<CodemodeInput> => ({
  name: "codemode",
  description: DESCRIPTION,
  input: CodemodeInput,
  nests: true,
  // No `replay`: a script may write files or run commands, so one cut off by a host restart is not run again.
  execute: (input, { sessionId, toolCallId, cwd, signal, update, offered, maxResultChars }) =>
    Effect.gen(function* () {
      const started = performance.now();
      const { code, options } = yield* Effect.try({ try: () => parseCodemodeSource(input.code), catch: (cause) => cause });
      const services = yield* Effect.context<never>();
      const listed = yield* registry.list;
      let count = 0;
      const tools = listed
        // Not a tool only the model calls (`direct`): its result must be logged as its own.
        .filter(({ spec, direct }) => spec.name !== "codemode" && direct !== true && (offered === undefined || offered.includes(spec.name)))
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
            const outcome = await Effect.runPromiseWith(services)(Effect.result(registry.execute(invocation, call.signal, { update: update ?? (() => {}) })));
            if (Result.isFailure(outcome)) throw new Error(outcome.failure.message);
            const text = contentText(outcome.success.content);
            if (outcome.success.isError) throw new Error(text || `Tool "${spec.name}" failed`);
            return text;
          },
        }));
      let usage: Usage | undefined;
      const sandbox = new CodemodeSandbox({
        tools,
        globals: [
          searchTools(tools),
          ...modelGlobals(
            llm,
            (effect, signal) => Effect.runPromiseWith(services)(effect, signal === undefined ? undefined : { signal }),
            (used) => (usage = usage === undefined ? used : addUsage(usage, used)),
          ),
        ],
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
      const budget = (options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * CHARS_PER_TOKEN;
      // Under the registry's cap with room for the header, so the note naming the full output survives it.
      const { content, fullOutputPath } = yield* Effect.promise(() => boundOutput(items, { budget, maxResultChars, name: "codemode" }));
      const wallTime = ((performance.now() - started) / 1000).toFixed(1);
      const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
      const details: CodemodeDetails = {
        calls: result.calls,
        ...(fullOutputPath === undefined ? {} : { truncated: true, fullOutputPath }),
        ...(usage === undefined ? {} : { usage }),
      };
      return new ToolResult({ content: [{ type: "text", text: header }, ...content], ...(result.ok ? {} : { isError: true }), details });
    }),
});
