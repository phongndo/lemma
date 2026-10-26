// Adapted from pi (MIT): packages/coding-agent/src/extensions/codemode/{tool,execute}.ts.
import { randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { renderToolSample, renderToolSignature, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import type { CodemodeDeclaredGlobal, CodemodeDeclaredTool, CodemodeError, CodemodeHostCall, CodemodeOutcome, CodemodeRun } from "@earendil-works/pi-codemode";
import { Effect, Result, Schema, Semaphore } from "effect";
import type { Context } from "effect";
import { CoreClosed } from "@lemma/core";
import { addUsage, ClassifierContext, contentText, ImagesContext } from "@lemma/llm";
import type { Llm, Usage } from "@lemma/llm";
import { outputBudget, ToolInvocation, ToolResult } from "@lemma/tools";
import type { ImageBlock, Tool, ToolContribution, ToolNamespace, ToolRunner } from "@lemma/tools";
import { boundOutput, outputFile } from "@lemma/tools/files";
import type { CodemodeCallRecord, CodemodeDetails, CodemodeDisplay } from "./details.ts";
import type { Journal, JournalHeader, Journals } from "./journal.ts";
import { namespaceKey, rank } from "./search.ts";

export const CodemodeInput = Schema.Struct({
  code: Schema.String.annotate({ description: "Raw JavaScript source." }),
});
export type CodemodeInput = typeof CodemodeInput.Type;

type Content = ToolResult["content"][number];

/** What the plugin hands the tool. */
export interface CodemodeDeps {
  readonly registry: Context.Service.Shape<typeof ToolRunner>;
  readonly llm: Context.Service.Shape<typeof Llm>;
  /** The namespaces tools belong to, now. */
  readonly namespaces: () => readonly ToolNamespace[];
  /** What scripts read of the branch ending at `leafId`. */
  readonly branch: (sessionId: string, leafId: string | undefined) => Effect.Effect<CodemodeBranch>;
  /** Where scripts keep their journals; without it a script cut off by a restart is not resumed. */
  readonly journals?: Journals;
  /**
   * Whether the core is shutting down, asked when a call fails: one that fails then (its tool gone as its plugin stops)
   * failed for that alone, so it is held unanswered until the turn is interrupted, to resume after the restart.
   */
  readonly closing?: Effect.Effect<boolean>;
}

/** What scripts read of a branch. */
export interface CodemodeBranch {
  /** What `store()` holds there. */
  readonly store: Readonly<Record<string, unknown>>;
  /** The codemode calls whose results it logs: a journal under one of their ids is another call's. */
  readonly answered: ReadonlySet<string>;
}

/** A call held unanswered because the core is shutting down; `unrun`: it began, but never reached its tool. */
class Held {
  readonly unrun: boolean;
  constructor(unrun: boolean) {
    this.unrun = unrun;
  }
}

/**
 * A call settled: what the script hears, and what it showed when it is a `display` call that showed something, or its
 * name (`unshown`) when it would have, past what one script shows.
 */
interface Settled {
  readonly outcome: CodemodeOutcome;
  readonly display?: CodemodeDisplay;
  readonly unshown?: string;
}

/**
 * The VM's heap. The sandbox runs in a worker of the host's process, so a runaway script must
 * not grow to wasm32's 4 GiB; past this it fails inside the script with `InternalError: out of memory`.
 */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** A script without a `timeout_ms` stops after this. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** What a call of a tool that declares no output resolves to: its text (or `{ text, images }`, which the description names). */
const TEXT_OUTPUT = { type: "string" };
/** Results of `searchTools` without a `limit`. */
const SEARCH_LIMIT = 8;
/** `models` calls one script has in flight; `Promise.all` over many items queues the rest. */
const MAX_MODEL_CALLS = 4;
/** Calls the result's details keep, so a script of thousands does not bloat the log. */
const MAX_KEPT_CALLS = 500;
/**
 * What one script may show (`display` calls), in calls and in their results' size together: each is kept in the
 * script's result, which is logged and loaded by every client reading the thread.
 */
const MAX_DISPLAYS = 20;
const MAX_DISPLAY_BYTES = 10 * 1024 * 1024;
/** A shown call as the result names it to the model: its tool, and its title. */
const named = (display: CodemodeDisplay) => (display.title === undefined ? display.name : `${display.name} "${display.title}"`);

/** A call's arguments as its line shows them. */
const ARGS_CHARS = 160;

/**
 * pi's description, with the tools all directly callable, as pi's default mode has them: their declarations are the
 * model's own tool list, so they are not repeated here. Tools only scripts call (`nested`) are found by searching, and
 * the system prompt names their namespaces, so the description stays the same as they come and go.
 */
const DESCRIPTION = `Run JavaScript that calls other tools. The code is raw JavaScript (no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` calls any of your other tools with the same arguments (characters not valid in identifiers become \`_\`). It resolves to what the tool's declaration says (\`bash\` to \`{ output, exitCode, truncated, fullOutputPath?, wallTimeSeconds }\` with up to 1 MiB of output, \`read\` to text or an image block; one declared \`Promise<string>\` to \`{ text, images }\` instead when its result has images), and rejects with an Error on failure; a tool declaring an object resolves on failure too, so check its fields. Calls still running when the script ends are cancelled.
- Some tools are not in your tool list: only scripts call them, in namespaces the system prompt names. Find them with \`await searchTools(query, { limit?, namespace? })\`, \`await describeTool(name)\` (its declaration), and \`await describeNamespace(name)\` (how its tools work together), or \`ALL_TOOLS\`.
- Optional first line: \`// @options: {"timeout_ms": 60000}\`. Without it, a script stops after 300 seconds; image generation can take minutes.

Globals:
- \`text(value)\`, \`image(imageBlockOrDataUrl)\`, \`console.log(...)\`, and top-level \`return\` add output; \`exit()\` ends the script. \`image()\` also saves the image to a temp file whose path the output names.
- \`store(key, value)\` and \`load(key)\` keep small JSON values (ids, cursors, results to reuse) across codemode calls on this branch of the session; a script's writes are kept when it succeeds.
- \`models\` runs models that are not chat models with the session's credentials, four calls at a time:
  - Classifiers answer typed questions about JSON state (and images, where \`input\` includes "image") with calibrated probabilities, fast and cheaply, such as TypeSafe's Jev. List them with \`await models.getAvailableOfType("classifier")\` (\`{ ref, provider, id, name, input }\`; \`getModelsOfType\` lists all, \`getModelOfType(type, provider, id)\` finds one). \`await models.classify(model, { state, images?, questions })\`, \`model\` an entry or a ref such as "typesafe/jev-latest", \`questions\` mapping ids to \`{ type: "choice", instructions, criteria: { <label>: <meaning> } }\`, \`{ type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] }\`, or \`{ type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } }\`, resolves to \`{ answers, stopReason, errorMessage? }\`, answers by id: \`{ choice, probabilities, confidence }\`, \`{ score, confidence }\` (the expected level index), or \`{ probability }\` (of true). It does not throw on a provider's failure: check \`stopReason === "stop"\`. Ask about many items or steps with one call each, ask each factor of a judgment as its own question and combine the answers in code, and act only on confident answers.
  - Image models: \`await models.getAvailableOfType("image")\`, then \`await models.generateImages(model, { input: [{ type: "text", text }, ...imageBlocks] })\` resolves to \`{ output, stopReason, errorMessage? }\`; show \`output\` images with \`image(block)\`, never print their data.

Use codemode to batch independent tool calls (Promise.allSettled), chain them, filter large output, or loop a classifier over many items or steps, instead of many separate calls.`;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
const valueText = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

/** A call's arguments in a line; a model call's, by the model's ref. */
const argsLine = (args: unknown, name?: string): string | undefined => {
  if (args === undefined || args === null) return undefined;
  if (name === "models.classify" || name === "models.generateImages") return refOf((args as readonly unknown[])[0]);
  const text = (JSON.stringify(args) ?? "").replace(/\s+/g, " ");
  return text.length <= ARGS_CHARS ? text : `${text.slice(0, ARGS_CHARS - 1)}…`;
};

const decodeClassifierContext = Schema.decodeUnknownResult(ClassifierContext);
const decodeImagesContext = Schema.decodeUnknownResult(ImagesContext);

/** Image blocks as a model takes them: `note`, which `read` adds, is the script's. */
const plainImages = (context: unknown): unknown => {
  if (typeof context !== "object" || context === null) return context;
  const record = context as Record<string, unknown>;
  const strip = (blocks: unknown) =>
    Array.isArray(blocks)
      ? blocks.map((block: unknown) => {
          if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "image") return block;
          const { type, data, mimeType } = block as { type: unknown; data: unknown; mimeType: unknown };
          return { type, data, mimeType };
        })
      : blocks;
  return { ...record, ...("images" in record ? { images: strip(record["images"]) } : {}), ...("input" in record ? { input: strip(record["input"]) } : {}) };
};

/** The ref a script names a model by: a ref, an entry with one, or `{ provider, id }`. */
const refOf = (model: unknown): string | undefined => {
  if (typeof model === "string") return model;
  if (typeof model !== "object" || model === null) return undefined;
  const { ref, provider, id } = model as { ref?: unknown; provider?: unknown; id?: unknown };
  if (typeof ref === "string") return ref;
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
};

type ModelType = "chat" | "image" | "classifier";
const MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];

function formatError(error: CodemodeError, calls: readonly CodemodeCallRecord[]): string {
  const head =
    error.kind === "script"
      ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  const made = calls.filter((call) => !call.name.startsWith("searchTools") && !call.name.startsWith("describe"));
  const summary =
    made.length === 0
      ? "No tool calls were made."
      : `Tool calls made before the failure (they are not undone): ${made.map((call) => `${call.name} (${call.status})`).join(", ")}`;
  return `${head}\n\n${summary}`;
}

/** Saves an output image where later calls can copy or move it, and says where. */
async function savedImage(image: { readonly data: string; readonly mimeType: string }): Promise<string> {
  const extension =
    image.mimeType
      .split("/")[1]
      ?.replace("jpeg", "jpg")
      .replace(/[^a-z0-9]/g, "") || "img";
  const file = outputFile("lemma-codemode-image", extension);
  try {
    await writeFile(file.path, Buffer.from(image.data, "base64"));
    return `[Image saved to ${file.path}]`;
  } catch (cause) {
    return `[Image could not be saved: ${cause instanceof Error ? cause.message : String(cause)}]`;
  } finally {
    file.release();
  }
}

/** A tool as a script sees it: its contribution, and its declaration. */
interface Callable {
  readonly contribution: ToolContribution;
  readonly jsName: string;
  readonly sample: string;
}

/**
 * Nested calls go through the live registry, as the agent's own calls do, so hooks and guards apply to them, and in
 * this call's fiber context, so they keep its interaction origin and trace. A script reaches only the tools the request
 * offered, read per script, and never codemode. Each call it makes is journaled before and after it runs, so a script
 * a host restart cut off runs again from its journal: what had settled is answered as it was, and only what had not
 * runs (a call cut off mid-way runs again only when it is safe to repeat).
 */
export const codemodeTool = (deps: CodemodeDeps): Tool<CodemodeInput> => ({
  name: "codemode",
  description: DESCRIPTION,
  input: CodemodeInput,
  nests: true,
  // Its journal makes running it again safe: what its first run did is answered from there, not done twice.
  ...(deps.journals === undefined ? {} : { replay: "safe" as const }),
  execute: (input, { sessionId, toolCallId, cwd, signal, update, offered, maxResultChars, leafId }) =>
    Effect.gen(function* () {
      const started = performance.now();
      const { code, options } = yield* Effect.try({ try: () => parseCodemodeSource(input.code), catch: (cause) => cause });
      const services = yield* Effect.context<never>();
      const runEffect = <A, E>(effect: Effect.Effect<A, E>, abort?: AbortSignal) =>
        Effect.runPromiseWith(services)(effect, abort === undefined ? undefined : { signal: abort });

      const journal: Journal | undefined = deps.journals?.open(sessionId, toolCallId);
      const branch = yield* deps.branch(sessionId, leafId);
      // A journal under the id of a call whose result is logged is that call's (cancelled, or finished), not this one's.
      const earlier =
        journal === undefined || branch.answered.has(toolCallId) ? ({ kind: "none" } as const) : yield* Effect.promise(() => journal.earlier(input.code));
      // Finished before the host stopped, its result unlogged: the agent asks again, and gets it.
      if (earlier.kind === "done") return yield* Schema.decodeUnknownEffect(ToolResult)(earlier.result).pipe(Effect.orDie);

      const listed = yield* deps.registry.list;
      const callable = new Map<string, Callable>();
      for (const contribution of listed) {
        const { spec } = contribution;
        // Not itself, nor a tool only the model calls (`direct`): its result must be logged as its own.
        if (spec.name === "codemode" || contribution.direct === true || (offered !== undefined && !offered.includes(spec.name))) continue;
        callable.set(spec.name, {
          contribution,
          jsName: toCodemodeIdentifier(spec.name),
          sample: renderToolSample({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.parameters,
            outputSchema: contribution.output ?? TEXT_OUTPUT,
          }),
        });
      }
      const byJsName = new Map([...callable.values()].map((tool) => [tool.jsName, tool] as const));
      const namespaces = deps.namespaces();
      const namespaceOf = (name: string) =>
        namespaces.find((namespace) => [namespace.name, ...(namespace.aliases ?? [])].some((alias) => namespaceKey(alias) === namespaceKey(name)));

      const resumed = earlier.kind === "cut" ? earlier : undefined;
      const store = resumed?.header.store ?? branch.store;
      const declared: readonly CodemodeDeclaredTool[] =
        resumed?.header.tools ?? [...callable.values()].map((tool) => ({ name: tool.contribution.spec.name, jsName: tool.jsName, description: tool.sample }));
      const globals: readonly CodemodeDeclaredGlobal[] = resumed?.header.globals ?? [
        { name: "searchTools", spread: true },
        { name: "describeTool", spread: true },
        { name: "describeNamespace", spread: true },
        { name: "models.getModelsOfType", spread: true },
        { name: "models.getAvailableOfType", spread: true },
        { name: "models.getModelOfType", spread: true },
        { name: "models.classifiers", spread: true },
        { name: "models.classify", spread: true },
        { name: "models.generateImages", spread: true },
      ];
      const header: JournalHeader = resumed?.header ?? {
        type: "header",
        version: 1,
        code: input.code,
        startedAt: Date.now(),
        seed: randomInt(0, 2 ** 32),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        tools: declared,
        globals,
        store,
      };
      if (journal !== undefined && resumed === undefined) yield* Effect.promise(() => journal.begin(header));

      /** Each call as it settled, with the VM's number for it: the result lists them in the order the script made them. */
      const records: { readonly id: number; readonly call: CodemodeCallRecord }[] = [];
      const displays: { readonly id: number; readonly display: CodemodeDisplay }[] = [];
      /** The `display` calls past what a script shows, named: they ran, and the result says they were not shown. */
      const unshown: { readonly id: number; readonly name: string }[] = [];
      /** What the script's `display` calls have shown, in calls and size; past either limit, a call shows nothing. */
      const shown = { calls: 0, bytes: 0 };
      const fits = (display: CodemodeDisplay) => {
        const bytes = JSON.stringify(display).length;
        if (shown.calls >= MAX_DISPLAYS || shown.bytes + bytes > MAX_DISPLAY_BYTES) return false;
        shown.calls++;
        shown.bytes += bytes;
        return true;
      };
      let usage: Usage | undefined;
      const used = (more: Usage | undefined) => {
        if (more !== undefined) usage = usage === undefined ? more : addUsage(usage, more);
      };
      const record = (id: number, call: CodemodeCallRecord) => {
        records.push({ id, call });
        const mark = call.status === "ok" ? "✓" : call.status === "cancelled" ? "–" : "✗";
        update?.(
          `${mark} ${call.name} ${Math.round(call.durationMs)}ms${call.args === undefined ? "" : ` ${call.args}`}${call.replayed ? " (from before the restart)" : ""}\n`,
        );
      };

      // `models.*`: the models `Llm` lists, and `classify` and `generateImages` through it with the session's credentials.
      const modelCalls = Semaphore.makeUnsafe(MAX_MODEL_CALLS);
      const listOf = async (type: unknown, available: boolean, provider?: unknown): Promise<unknown[]> => {
        if (!MODEL_TYPES.includes(type as ModelType))
          throw new Error(`models: the type is one of ${MODEL_TYPES.map((name) => `"${name}"`).join(", ")}, not ${JSON.stringify(type)}`);
        const query = { available };
        const entries: readonly { readonly provider: string }[] =
          type === "classifier"
            ? (await runEffect(deps.llm.classifiers(query))).map((model) => ({ type, ...model }))
            : type === "image"
              ? (await runEffect(deps.llm.imageModels(query))).map((model) => ({ type, ...model }))
              : (await runEffect(deps.llm.models(query))).map((model) => ({ type, ...model }));
        return typeof provider === "string" ? entries.filter((entry) => entry.provider === provider) : [...entries];
      };
      const modelRef = (name: string, model: unknown, type: string) => {
        const ref = refOf(model);
        if (ref === undefined)
          throw new Error(`${name}() expects a ${type} model first: an entry of models.getAvailableOfType("${type}"), or a ref such as "provider/model"`);
        return ref;
      };
      const runGlobal = async (name: string, args: readonly unknown[], abort: AbortSignal): Promise<unknown> => {
        switch (name) {
          case "searchTools": {
            const [query, options] = args as [unknown, { readonly limit?: unknown; readonly namespace?: unknown } | null | undefined];
            if (typeof query !== "string") throw new Error("searchTools() expects a query string");
            const limitTo = options?.limit ?? SEARCH_LIMIT;
            if (typeof limitTo !== "number" || !Number.isInteger(limitTo) || limitTo <= 0) throw new Error("searchTools() limit must be a positive integer");
            const within = options?.namespace;
            if (within !== undefined && within !== null && typeof within !== "string") throw new Error("searchTools() namespace must be a name");
            const space = typeof within === "string" ? namespaceOf(within) : undefined;
            if (typeof within === "string" && space === undefined) throw new Error(`searchTools(): no namespace "${within}"; the system prompt names them`);
            const documents = [...callable.values()]
              .filter((tool) => space === undefined || tool.contribution.namespace === space.name)
              .map((tool) => ({
                tool,
                name: tool.contribution.spec.name,
                description: tool.contribution.spec.description,
                ...(tool.contribution.namespace === undefined ? {} : { context: namespaceOf(tool.contribution.namespace)?.description ?? "" }),
              }));
            return rank(documents, query)
              .slice(0, limitTo)
              .map(({ tool }) => ({ name: tool.jsName, description: tool.sample }));
          }
          case "describeTool": {
            const [toolName] = args;
            if (typeof toolName !== "string") throw new Error("describeTool() expects a tool's name");
            const tool = byJsName.get(toCodemodeIdentifier(toolName)) ?? callable.get(toolName);
            if (tool === undefined) return undefined;
            const { spec, namespace, output } = tool.contribution;
            return {
              name: tool.jsName,
              ...(namespace === undefined ? {} : { namespace }),
              description: spec.description,
              declaration: renderToolSignature({ name: spec.name, inputSchema: spec.parameters, outputSchema: output ?? TEXT_OUTPUT }),
            };
          }
          case "describeNamespace": {
            const [spaceName] = args;
            if (typeof spaceName !== "string") throw new Error("describeNamespace() expects a namespace's name");
            const space = namespaceOf(spaceName);
            if (space === undefined) return undefined;
            return {
              name: space.name,
              description: space.description,
              ...(space.instructions === undefined ? {} : { instructions: space.instructions }),
              tools: [...callable.values()].filter((tool) => tool.contribution.namespace === space.name).map((tool) => tool.jsName),
            };
          }
          case "models.getModelsOfType":
            return listOf(args[0], false, args[1]);
          case "models.getAvailableOfType":
            return listOf(args[0], true, args[1]);
          case "models.getModelOfType": {
            const [type, provider, id] = args;
            if (typeof provider !== "string" || typeof id !== "string") throw new Error("models.getModelOfType() expects a type, a provider, and an id");
            return (await listOf(type, false)).find(
              (entry) => (entry as { provider: string; id: string }).provider === provider && (entry as { id: string }).id === id,
            );
          }
          case "models.classifiers": {
            const [options] = args as [{ readonly available?: unknown } | null | undefined];
            return runEffect(deps.llm.classifiers({ available: options?.available === true }));
          }
          case "models.classify": {
            const ref = modelRef("models.classify", args[0], "classifier");
            const decoded = decodeClassifierContext(plainImages(args[1]));
            if (Result.isFailure(decoded)) throw new Error(`models.classify() got a context it cannot use: ${decoded.failure.message}`);
            // Aborted when the script ends, times out, or is stopped: that interrupts the request, or its wait for a turn.
            const result = await runEffect(modelCalls.withPermits(1)(deps.llm.classify(ref, decoded.success)), abort);
            used(result.usage);
            return result;
          }
          case "models.generateImages": {
            const ref = modelRef("models.generateImages", args[0], "image");
            const decoded = decodeImagesContext(plainImages(args[1]));
            if (Result.isFailure(decoded)) throw new Error(`models.generateImages() got a context it cannot use: ${decoded.failure.message}`);
            const result = await runEffect(modelCalls.withPermits(1)(deps.llm.generateImages(ref, decoded.success)), abort);
            used(result.usage);
            return result;
          }
          default:
            throw new Error(`${name} is not a function`);
        }
      };

      // Asked once a call has failed, never on the way to one; a core shutting down stays so.
      let closed = false;
      const isClosing = async () => {
        if (!closed && deps.closing !== undefined) closed = await runEffect(deps.closing).catch(() => false);
        return closed;
      };

      // A nested call: through the registry, under an id of its own that a resumed run gives it again.
      const runTool = async (tool: Callable, args: unknown, id: number, abort: AbortSignal): Promise<Settled> => {
        const { spec, output, display } = tool.contribution;
        const invocation = new ToolInvocation({
          sessionId,
          toolCallId: `${toolCallId}/${id}`,
          name: spec.name,
          input: args,
          cwd,
          ...(offered === undefined ? {} : { offered }),
        });
        // Its live output is not shown: the script's call lines are.
        const settled = await runEffect(
          Effect.result(deps.registry.execute(invocation, abort, { update: () => {} })).pipe(
            // Refused by a core shutting down, as it refuses every call from then on: it never reached its tool.
            Effect.catchDefect((defect) => (defect instanceof CoreClosed ? Effect.succeed(undefined) : Effect.die(defect))),
          ),
        );
        if (settled === undefined) throw new Held(true);
        // Gone as the core shuts down (its plugin stopped first): it never ran, and runs when the script resumes.
        if (Result.isFailure(settled) && settled.failure.reason === "NotFound" && (await isClosing())) throw new Held(true);
        if (Result.isFailure(settled)) return { outcome: { ok: false, message: settled.failure.message } };
        const result = settled.success;
        const text = contentText(result.content);
        const images = result.content.filter((part) => part.type === "image");
        const outcome: CodemodeOutcome =
          output !== undefined && result.structured !== undefined
            ? { ok: true, value: result.structured }
            : result.isError === true
              ? { ok: false, message: text || `Tool "${spec.name}" failed` }
              : {
                  ok: true,
                  value:
                    images.length === 0
                      ? text
                      : { text, images: images.map((image): ImageBlock => ({ type: "image", data: image.data, mimeType: image.mimeType })) },
                };
        // A failed call shows what its result still holds for its view (an agent that failed); one holding nothing, nothing.
        if (display !== true || (result.isError === true && result.details === undefined)) return { outcome };
        const title = (args as { readonly title?: unknown } | null)?.title;
        const kept: CodemodeDisplay = {
          name: spec.name,
          ...(typeof title === "string" ? { title } : {}),
          content: result.content,
          ...(result.details === undefined ? {} : { details: result.details }),
        };
        // Past the limit it shows nothing, but it ran: the script hears what the tool answered, which may have done
        // more than show (an agent's work), and the result names it as not shown.
        if (!fits(kept)) return { outcome, unshown: named(kept) };
        return { outcome, display: kept };
      };

      // The sandbox (QuickJS in WebAssembly, on a worker) loads with the first script rather than with the plugin.
      const { CodemodeSandbox } = yield* Effect.tryPromise({ try: () => import("@earendil-works/pi-codemode"), catch: (cause) => cause });
      const sandbox = new CodemodeSandbox({ memoryLimitBytes: MEMORY_LIMIT_BYTES });
      // Results are numbered in the order they settle, after those a resumed run answers from its journal.
      let nextSeq = (resumed?.results.size ?? 0) + 1;
      const pending = new Map<number, { readonly name: string; readonly args: unknown; readonly at: number }>();
      let run!: CodemodeRun;
      const deliver = (seq: number, now: number, id: number, outcome: CodemodeOutcome) => {
        if (run.finished) return;
        try {
          run.deliver(seq, now, id, outcome);
        } catch {
          // The script ended meanwhile; the call is cancelled.
        }
      };
      const nameOf = (call: CodemodeHostCall) =>
        call.target === "tool" ? (byJsName.get(toCodemodeIdentifier(call.name))?.contribution.spec.name ?? call.name) : call.name;
      // Stops the run when the call is cancelled, or when it cannot resume.
      const stopping = new AbortController();
      // Cancels the calls still running when the run ends (the script returned, threw, exited, or timed out) or stops.
      const ending = new AbortController();
      const stop = () => {
        stopping.abort(signal.reason);
        ending.abort(signal.reason);
      };
      const onCall = (call: CodemodeHostCall) => {
        const name = nameOf(call);
        const recorded = resumed?.results.get(call.id);
        if (recorded !== undefined) {
          record(call.id, {
            name,
            ...(argsLine(call.args, name) === undefined ? {} : { args: argsLine(call.args, name)! }),
            status: recorded.outcome.ok ? "ok" : "error",
            durationMs: 0,
            replayed: true,
          });
          // What the first run's model calls used was never logged: its result was not.
          if (recorded.outcome.ok && call.target === "global" && call.name.startsWith("models."))
            used((recorded.outcome.value as { usage?: Usage } | null)?.usage);
          // What it showed is shown again: the first run's result, which held it, was never logged either.
          if (recorded.display !== undefined) {
            fits(recorded.display);
            displays.push({ id: call.id, display: recorded.display });
          }
          if (recorded.unshown !== undefined) unshown.push({ id: call.id, name: recorded.unshown });
          deliver(recorded.seq, recorded.now, call.id, recorded.outcome);
          return;
        }
        const at = performance.now();
        pending.set(call.id, { name, args: call.args, at });
        const abort = ending.signal;
        void (async (): Promise<Settled | Held> => {
          try {
            const tool = call.target === "tool" ? (byJsName.get(toCodemodeIdentifier(call.name)) ?? callable.get(call.name)) : undefined;
            // Cut off while it ran: it may have had its effect, so it runs again only when that is safe.
            if (resumed?.started.has(call.id) === true && call.target === "tool" && tool?.contribution.replay !== "safe")
              return {
                outcome: {
                  ok: false,
                  message: `${name} was cut off by a host restart while it ran, so it may or may not have had its effect; it was not run again`,
                },
              };
            await journal?.append({ type: "start", id: call.id });
            let settled: Settled;
            if (call.target === "global") settled = { outcome: { ok: true, value: await runGlobal(call.name, call.args as readonly unknown[], abort) } };
            else if (tool === undefined) settled = { outcome: { ok: false, message: `Tool "${call.name}" is not available` } };
            else settled = await runTool(tool, call.args, call.id, abort);
            // Failed as the core shuts down: perhaps for that alone, so the script does not hear it; the journal keeps it begun.
            return !settled.outcome.ok && (await isClosing()) ? new Held(false) : settled;
          } catch (cause) {
            if (cause instanceof Held) return cause;
            if (await isClosing()) return new Held(false);
            return { outcome: { ok: false, message: cause instanceof Error ? cause.message : String(cause) } };
          }
        })().then(async (settled) => {
          // Held: never answered. The script waits on it until the turn is interrupted, as the core goes on shutting down.
          if (settled instanceof Held) {
            if (settled.unrun) await journal?.append({ type: "unrun", id: call.id });
            return;
          }
          const { outcome, display } = settled;
          const hidden = settled.unshown;
          if (run.finished || !pending.has(call.id)) return;
          pending.delete(call.id);
          const seq = nextSeq++;
          const now = Date.now();
          record(call.id, {
            name,
            ...(argsLine(call.args, name) === undefined ? {} : { args: argsLine(call.args, name)! }),
            status: outcome.ok ? "ok" : "error",
            durationMs: performance.now() - at,
          });
          // Kept before the script sees it, so a run resumed from here sees the same.
          await journal?.append({
            type: "result",
            seq,
            now,
            id: call.id,
            outcome,
            ...(display === undefined ? {} : { display }),
            ...(hidden === undefined ? {} : { unshown: hidden }),
          });
          if (display !== undefined) displays.push({ id: call.id, display });
          if (hidden !== undefined) unshown.push({ id: call.id, name: hidden });
          deliver(seq, now, call.id, outcome);
        });
      };

      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      let mismatched = false;
      run = sandbox.start(code, {
        startedAt: header.startedAt,
        seed: header.seed,
        tools: [...declared],
        globals: [...globals],
        store,
        signal: stopping.signal,
        timeoutMs: header.timeoutMs,
        onStarted: (fingerprint) => {
          // Another engine would not make the same calls: its journal cannot answer them.
          if (resumed?.header.fingerprint !== undefined && resumed.header.fingerprint !== fingerprint) {
            mismatched = true;
            stopping.abort("mismatched");
            ending.abort("mismatched");
          } else if (resumed === undefined) void journal?.append({ type: "fingerprint", fingerprint });
        },
        onCall,
      });
      const result = yield* Effect.tryPromise({ try: () => run.result, catch: (cause) => cause }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            signal.removeEventListener("abort", stop);
            ending.abort(new Error("The script ended"));
            await sandbox.close().catch(() => {});
          }),
        ),
      );
      if (mismatched) {
        return new ToolResult({
          content: [
            {
              type: "text",
              text: "Script failed\nA host restart cut this script off, and it cannot resume on this version of the sandbox, which would not make the same calls. Calls it made before the restart are not undone; run it again only if that is safe.",
            },
          ],
          isError: true,
          details: { calls: [] } satisfies CodemodeDetails,
        });
      }
      for (const [id, call] of pending)
        record(id, {
          name: call.name,
          ...(argsLine(call.args, call.name) === undefined ? {} : { args: argsLine(call.args, call.name)! }),
          status: "cancelled",
          durationMs: performance.now() - call.at,
        });
      pending.clear();

      const calls = [...records].sort((a, b) => a.id - b.id).map(({ call }) => call);
      const items: Content[] = [];
      for (const item of result.output) {
        if (item.type === "image") items.push({ type: "text", text: yield* Effect.promise(() => savedImage(item)) });
        items.push(item.type === "text" ? { type: "text", text: item.text } : { type: "image", data: item.data, mimeType: item.mimeType });
      }
      if (result.ok && result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
      if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result.error, calls)}` });
      // The model does not see what its script showed the person: it is told, so its reply neither repeats nor misses it.
      const showed = [...displays].sort((a, b) => a.id - b.id).map(({ display }) => display);
      if (showed.length > 0)
        items.push({ type: "text", text: `[Shown to the person outside your reply: ${showed.map(named).join(", ")}. Don't describe it again.]` });
      if (unshown.length > 0) {
        const limit = `one script shows at most ${MAX_DISPLAYS} pages, ${MAX_DISPLAY_BYTES / (1024 * 1024)} MiB together`;
        const names = [...unshown].sort((a, b) => a.id - b.id).map(({ name }) => name);
        items.push({
          type: "text",
          text: `[Not shown to the person, though they ran: ${names.join(", ")} (${limit}). Show what matters from another script.]`,
        });
      }
      // Under the call's budget with room for the header, so the note naming the full output survives the registry's cut.
      const { content, fullOutputPath } = yield* Effect.promise(() => boundOutput(items, { budget: outputBudget(maxResultChars), name: "codemode" }));
      const wallTime = ((performance.now() - started) / 1000).toFixed(1);
      const head = `${result.ok ? "Script completed" : "Script failed"}${resumed === undefined ? "" : " (resumed after a host restart)"}\nWall time ${wallTime} seconds\nOutput:\n`;
      const writes = result.ok && (Object.keys(result.storeWrites.set).length > 0 || result.storeWrites.delete.length > 0) ? result.storeWrites : undefined;
      const details: CodemodeDetails = {
        calls: calls.slice(0, MAX_KEPT_CALLS),
        ...(calls.length > MAX_KEPT_CALLS ? { callsOmitted: calls.length - MAX_KEPT_CALLS } : {}),
        ...(fullOutputPath === undefined ? {} : { truncated: true, fullOutputPath }),
        ...(usage === undefined ? {} : { usage }),
        ...(writes === undefined ? {} : { storeWrites: writes }),
        ...(showed.length === 0 ? {} : { displays: showed }),
        ...(resumed === undefined ? {} : { resumed: true }),
      };
      const done = new ToolResult({ content: [{ type: "text", text: head }, ...content], ...(result.ok ? {} : { isError: true }), details });
      if (journal !== undefined) {
        const encoded = yield* Schema.encodeEffect(ToolResult)(done).pipe(Effect.orDie);
        yield* Effect.promise(() => journal.append({ type: "done", result: encoded }));
      }
      return done;
    }),
});
