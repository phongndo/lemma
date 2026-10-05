import { Cause, Effect, ParseResult, Runtime, Schema } from "effect";
import type { Context } from "effect";
import { Events, Hooks, PluginContext, Registries, Registry } from "@lemma/core";
import { Inspectors, ToolError, ToolExecuteHook, ToolExecuted, ToolOutput, ToolResult } from "@lemma/contracts";
import type { Guard, Tool, ToolContext, ToolContribution, ToolInvocation, Tools } from "@lemma/contracts";
import { capResult } from "./content.ts";
import { toolParameters } from "./schema.ts";

type Service = Context.Tag.Service<typeof Tools>;

export interface RegistryOptions {
  /** Total text characters a result may carry to the model before it is truncated. */
  readonly maxResultChars: number;
}

/** A registered tool: schema converted and decoder built once. */
interface Entry {
  readonly tool: Tool<any>;
  readonly spec: ToolContribution["spec"];
  readonly decode: (input: unknown) => Effect.Effect<unknown, ToolError>;
}

interface GuardEntry {
  /** A tool name, or `*` for every tool. */
  readonly name: string;
  readonly guard: Guard;
}

/*
 * The core's registries hold what plugins register: each item belongs to the
 * plugin that registered it and leaves with it, and a plugin's replacement
 * takes over its names at the swap (so contributors need not be exclusive).
 * Private to this plugin: contributors go through `Tools.register` and `guard`.
 */
const ToolEntries = Registry.make<Entry>("lemma/tools", { key: (entry) => entry.tool.name, unique: true });
const Guards = Registry.make<GuardEntry>("lemma/tools.guards");

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause));

export const errorResult = (text: string, details?: unknown): ToolResult =>
  new ToolResult({ content: [{ type: "text", text }], isError: true, ...(details === undefined ? {} : { details }) });

const decodeResult = Schema.decodeUnknownEither(ToolResult);

/** How often a running tool's output is published, at most. */
const OUTPUT_INTERVAL_MS = 50;
/** Output kept between publishes; a flood keeps its tail, which is what a live view shows. */
const OUTPUT_MAX_CHARS = 64 * 1024;

/** Batches `ToolContext.update` chunks into one `publish` per interval; `flush` sends the rest. */
export const outputBatcher = (publish: (chunk: string, offset: number) => void, interval = OUTPUT_INTERVAL_MS) => {
  let pending = "";
  /** Everything printed so far, the parts a batch dropped included. */
  let printed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending === "") return;
    const chunk = pending;
    pending = "";
    publish(chunk, printed - chunk.length);
  };
  const update = (chunk: string) => {
    printed += chunk.length;
    pending += chunk;
    if (pending.length > OUTPUT_MAX_CHARS) pending = pending.slice(-OUTPUT_MAX_CHARS);
    timer ??= setTimeout(flush, interval);
  };
  return { update, flush };
};

/**
 * Runs a tool's `execute`, whichever shape it returns. A promise tool gets a
 * signal that aborts when the caller's signal does or when this fiber is
 * interrupted; an Effect tool is interrupted. Throws, rejections, failures,
 * defects, and malformed results become error results; interruption stays
 * interruption.
 */
function runTool(tool: Tool<any>, input: unknown, base: Omit<ToolContext, "signal">, outer: AbortSignal): Effect.Effect<ToolResult> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    const forward = () => controller.abort(outer.reason);
    outer.addEventListener("abort", forward, { once: true });
    const context: ToolContext = { ...base, signal: controller.signal };
    let output: Promise<ToolResult> | Effect.Effect<ToolResult, unknown>;
    try {
      output = tool.execute(input, context);
    } catch (cause) {
      return Effect.succeed(errorResult(message(cause)));
    }
    const running: Effect.Effect<unknown, unknown> = Effect.isEffect(output)
      ? output
      : Effect.tryPromise({ try: () => output as Promise<ToolResult>, catch: (cause) => cause });
    return running.pipe(
      Effect.map((value) => {
        const decoded = decodeResult(value);
        return decoded._tag === "Right" ? decoded.right : errorResult(`Tool "${tool.name}" returned an invalid result: ${decoded.left.message}`);
      }),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed(errorResult(message(Cause.squash(cause)))),
      ),
      Effect.onInterrupt(() => Effect.sync(() => controller.abort("interrupted"))),
      Effect.ensuring(Effect.sync(() => outer.removeEventListener("abort", forward))),
    );
  });
}

/** Fails with `Cancelled` once the signal aborts. */
const aborted = (tool: string, signal: AbortSignal) =>
  Effect.async<never, ToolError>((resume) => {
    const cancel = () => resume(Effect.fail(new ToolError({ tool, reason: "Cancelled", message: `Tool "${tool}" was cancelled` })));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });

export const makeRegistry = (options: RegistryOptions): Effect.Effect<Service, never, Hooks | Events | PluginContext | Registries> =>
  Effect.gen(function* () {
    const hooks = yield* Hooks;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const registries = yield* Registries;
    const entries = registries.items(ToolEntries);
    const names = Effect.map(entries, (items) => items.map((contribution) => contribution.item.tool.name));
    const find = (name: string) => Effect.map(entries, (items) => items.find((contribution) => contribution.item.tool.name === name));

    const register: Service["register"] = (tool) =>
      Effect.gen(function* () {
        const contributor = yield* PluginContext;
        const decodeInput = Schema.decodeUnknown(tool.input);
        const entry: Entry = {
          tool,
          spec: { name: tool.name, description: tool.description, parameters: toolParameters(tool.input) },
          decode: (input) =>
            decodeInput(input, { errors: "all", onExcessProperty: "ignore" }).pipe(
              Effect.mapError(
                (error) =>
                  new ToolError({
                    tool: tool.name,
                    reason: "InvalidInput",
                    message: `Validation failed for tool "${tool.name}":\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
                    cause: error,
                  }),
              ),
            ),
        };
        const remove = yield* contributor.add(ToolEntries, entry).pipe(
          Effect.catchTag("RegistryError", (error) =>
            Effect.fail(
              new ToolError({
                tool: tool.name,
                reason: "InvalidInput",
                message: error.reason === "Conflict" ? `Tool "${tool.name}" is already registered by ${error.holder}` : error.message,
                cause: error,
              }),
            ),
          ),
          Effect.catchTag("CoreClosed", (error) =>
            Effect.fail(new ToolError({ tool: tool.name, reason: "Failed", message: "The core has closed", cause: error })),
          ),
        );
        // Gone when the registering scope closes, or with the plugin, whichever is first.
        yield* Effect.addFinalizer(() => remove);
      });

    // Lifted when the installing scope closes, or with the plugin, whichever is first.
    const guard: Service["guard"] = (name, check) =>
      Effect.flatMap(PluginContext, (contributor) => contributor.add(Guards, { name, guard: check })).pipe(
        Effect.orDie,
        Effect.flatMap((remove) => Effect.addFinalizer(() => remove)),
      );

    const list: Service["list"] = Effect.map(entries, (items) =>
      items
        .map((contribution) => ({
          source: contribution.pluginId,
          spec: contribution.item.spec,
          ...(contribution.item.tool.replay === undefined ? {} : { replay: contribution.item.tool.replay }),
          ...(contribution.item.tool.outputSchema === undefined ? {} : { outputSchema: contribution.item.tool.outputSchema }),
        }))
        .sort((a, b) => (a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0)),
    );

    const unknown = (name: string, names: string[]) =>
      new ToolError({
        tool: name,
        reason: "NotFound",
        message: `Tool "${name}" not found. Available tools: ${names.sort().join(", ") || "(none)"}`,
      });

    /** Guards, then the tool. Runs as the hook's terminal so no handler can route around a guard. */
    const terminal =
      (original: ToolInvocation, decoded: unknown, signal: AbortSignal, update: ((chunk: string) => void) | undefined) =>
      (call: ToolInvocation): Effect.Effect<ToolResult, ToolError> =>
        Effect.gen(function* () {
          const found = yield* find(call.name);
          if (found === undefined) return yield* unknown(call.name, yield* names);
          const entry = found.item;
          // A handler that rewrote the call gets its input validated again.
          const input = call === original ? decoded : yield* entry.decode(call.input);
          for (const candidate of yield* registries.items(Guards)) {
            if (candidate.item.name !== "*" && candidate.item.name !== call.name) continue;
            const decision = yield* candidate.item.guard(call);
            if (decision._tag === "deny") return errorResult(`Tool call denied: ${decision.reason}`, { deniedBy: candidate.pluginId });
          }
          const runtime = yield* Effect.runtime<never>();
          const output =
            update === undefined
              ? outputBatcher((chunk, offset) =>
                  Runtime.runFork(runtime)(events.publish(ToolOutput, { sessionId: call.sessionId, toolCallId: call.toolCallId, chunk, offset })),
                )
              : { update, flush: () => {} };
          const context = {
            sessionId: call.sessionId,
            toolCallId: call.toolCallId,
            cwd: call.cwd,
            update: output.update,
            maxResultChars: options.maxResultChars,
            ...(call.offered === undefined ? {} : { offered: call.offered }),
          };
          return yield* runTool(entry.tool, input, context, signal).pipe(Effect.ensuring(Effect.sync(output.flush)));
        });

    const execute: Service["execute"] = (invocation, signal, executeOptions) =>
      owner.trace(
        `tools.execute ${invocation.name}`,
        Effect.gen(function* () {
          const found = yield* find(invocation.name);
          if (found === undefined) return yield* unknown(invocation.name, yield* names);
          // A tool the request did not offer is not there for this call, whoever makes it (a model, or a tool running others).
          if (invocation.offered !== undefined && !invocation.offered.includes(invocation.name)) {
            return yield* unknown(invocation.name, [...invocation.offered]);
          }
          const entry = found.item;
          if (signal.aborted) return yield* new ToolError({ tool: invocation.name, reason: "Cancelled", message: `Tool "${invocation.name}" was cancelled` });
          const started = Date.now();
          const settled = yield* entry.decode(invocation.input).pipe(
            Effect.flatMap((decoded) => hooks.invoke(ToolExecuteHook, invocation, terminal(invocation, decoded, signal, executeOptions?.update))),
            Effect.map((result) => capResult(result, options.maxResultChars)),
            // Handler failures, invalid input, and denials are results the model reads and can act on.
            Effect.catchAll((error) => Effect.succeed(errorResult(error.message))),
            Effect.raceFirst(aborted(invocation.name, signal)),
          );
          yield* events.publish(ToolExecuted, { invocation, result: settled, durationMs: Date.now() - started });
          return settled;
        }),
      );

    // What the devtools and `lemma inspect` show of it. Only a view: failing to add it never stops the tools.
    yield* owner
      .add(Inspectors, {
        id: "tools.registered",
        title: "Tools",
        description: "Every tool the model can call, the plugin that registered it, and the guards that check calls",
        snapshot: Effect.map(Effect.all([entries, registries.items(Guards)]), ([tools, guards]) => ({
          tools: tools.map(({ item, pluginId }) => ({ name: item.tool.name, plugin: pluginId, description: item.spec.description })),
          guards: guards.map(({ item, pluginId }) => ({ tool: item.name, plugin: pluginId })),
        })),
      })
      .pipe(Effect.ignore);

    return { register, guard, list, execute } satisfies Service;
  });
