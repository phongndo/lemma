import { Cause, Effect, Order, Result, Schema } from "effect";
import type { Context } from "effect";
import { awaitable, Events, Hooks, PluginContext, Registries } from "@lemma/core";
import { Inspectors } from "@lemma/contracts";
import { Guards, ToolError, ToolExecuteHook, ToolExecuted, ToolOutput, ToolResult, Tools } from "@lemma/tools";
import type { ExecuteOptions, Tool, ToolContext, ToolContribution, ToolInvocation, ToolRunner } from "@lemma/tools";
import { capResult } from "./content.ts";
import { toolParameters } from "./schema.ts";

type Service = Context.Service.Shape<typeof ToolRunner>;

interface RegistryOptions {
  /** Total text characters a result may carry to the model before it is truncated. */
  readonly maxResultChars: number;
}

/** A tool as this registry uses it: its schema converted and its decoder built once, on first use. */
interface Entry {
  readonly tool: Tool<any>;
  readonly spec: ToolContribution["spec"];
  readonly decode: (input: unknown) => Effect.Effect<unknown, ToolError>;
}

/** Each tool's entry, by the tool: made once, and gone with the tool. */
const entries = new WeakMap<Tool<any>, Entry>();
const entryOf = (tool: Tool<any>): Entry => {
  const known = entries.get(tool);
  if (known !== undefined) return known;
  const decodeInput = Schema.decodeUnknownEffect(tool.input);
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
              message: `Validation failed for tool "${tool.name}":\n${error.message}`,
              cause: error,
            }),
        ),
      ),
  };
  entries.set(tool, entry);
  return entry;
};

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause));

const errorResult = (text: string, details?: unknown): ToolResult =>
  new ToolResult({ content: [{ type: "text", text }], isError: true, ...(details === undefined ? {} : { details }) });

const decodeResult = Schema.decodeUnknownResult(ToolResult);

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
 * A caller's `ExecuteOptions.update` as the tool's `update`: what it returns
 * (an Effect, a promise) runs on its own, and its failure is logged rather
 * than thrown into the tool, whose output is only shown.
 */
const listening =
  (update: NonNullable<ExecuteOptions["update"]>, services: Context.Context<never>) =>
  (chunk: string): void => {
    const failed = (cause: Cause.Cause<unknown>) => void Effect.runForkWith(services)(Effect.logWarning("A tool output listener failed", cause));
    try {
      const result = update(chunk);
      if (Effect.isEffect(result)) Effect.runForkWith(services)(result.pipe(Effect.catchCause((cause) => Effect.sync(() => failed(cause)))));
      else if (typeof (result as PromiseLike<void> | undefined)?.then === "function")
        (result as PromiseLike<void>).then(undefined, (error: unknown) => failed(Cause.die(error)));
    } catch (error) {
      failed(Cause.die(error));
    }
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
    // A value, a promise, or an Effect; a throw or rejection is a defect, which becomes an error result below.
    const running: Effect.Effect<unknown, unknown> = awaitable(() => tool.execute(input, context));
    return running.pipe(
      Effect.map((value) => {
        const decoded = decodeResult(value);
        return Result.isSuccess(decoded) ? decoded.success : errorResult(`Tool "${tool.name}" returned an invalid result: ${decoded.failure.message}`);
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed(errorResult(message(Cause.squash(cause)))),
      ),
      Effect.onInterrupt(() => Effect.sync(() => controller.abort("interrupted"))),
      Effect.ensuring(Effect.sync(() => outer.removeEventListener("abort", forward))),
    );
  });
}

/** Fails with `Cancelled` once the signal aborts. */
const aborted = (tool: string, signal: AbortSignal) =>
  Effect.callback<never, ToolError>((resume) => {
    const cancel = () => resume(Effect.fail(new ToolError({ tool, reason: "Cancelled", message: `Tool "${tool}" was cancelled` })));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });

/**
 * The `ToolRunner` over what `Tools` and `Guards` hold. The core's registries keep what plugins add: each item belongs
 * to the plugin that added it and leaves with it, and a plugin's replacement takes over its names at the swap (so
 * contributors need not be exclusive).
 */
export const makeRegistry = (options: RegistryOptions): Effect.Effect<Service, never, Hooks | Events | PluginContext | Registries> =>
  Effect.gen(function* () {
    const hooks = yield* Hooks;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const registries = yield* Registries;
    const added = registries.items(Tools);
    const names = Effect.map(added, (items) => items.map((contribution) => contribution.item.name));
    const find = (name: string) =>
      Effect.map(added, (items) => {
        const found = items.find((contribution) => contribution.item.name === name);
        return found === undefined ? undefined : entryOf(found.item);
      });

    const list: Service["list"] = Effect.map(added, (items) =>
      items
        .map(({ item: tool, pluginId }) => ({
          source: pluginId,
          spec: entryOf(tool).spec,
          ...(tool.replay === undefined ? {} : { replay: tool.replay }),
          ...(tool.parallel === undefined ? {} : { parallel: tool.parallel }),
        }))
        .sort((a, b) => Order.String(a.spec.name, b.spec.name)),
    );

    const unknown = (name: string, names: string[]) =>
      new ToolError({
        tool: name,
        reason: "NotFound",
        message: `Tool "${name}" not found. Available tools: ${names.sort().join(", ") || "(none)"}`,
      });

    /** Guards, then the tool. Runs as the hook's terminal so no handler can route around a guard. */
    const terminal =
      (original: ToolInvocation, decoded: unknown, signal: AbortSignal, update: ExecuteOptions["update"]) =>
      (call: ToolInvocation): Effect.Effect<ToolResult, ToolError> =>
        Effect.gen(function* () {
          const entry = yield* find(call.name);
          if (entry === undefined) return yield* unknown(call.name, yield* names);
          // A handler that rewrote the call gets its input validated again.
          const input = call === original ? decoded : yield* entry.decode(call.input);
          for (const candidate of yield* registries.items(Guards)) {
            if (candidate.item.tool !== "*" && candidate.item.tool !== call.name) continue;
            const decision = yield* awaitable(() => candidate.item.guard(call));
            if (decision._tag === "deny") return errorResult(`Tool call denied: ${decision.reason}`, { deniedBy: candidate.pluginId });
          }
          const services = yield* Effect.context<never>();
          const output =
            update === undefined
              ? outputBatcher((chunk, offset) =>
                  Effect.runForkWith(services)(events.publish(ToolOutput, { sessionId: call.sessionId, toolCallId: call.toolCallId, chunk, offset })),
                )
              : { update: listening(update, services), flush: () => {} };
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
          const entry = yield* find(invocation.name);
          if (entry === undefined) return yield* unknown(invocation.name, yield* names);
          // A tool the request did not offer is not there for this call, whoever makes it (a model, or a tool running others).
          if (invocation.offered !== undefined && !invocation.offered.includes(invocation.name)) {
            return yield* unknown(invocation.name, [...invocation.offered]);
          }
          if (signal.aborted) return yield* new ToolError({ tool: invocation.name, reason: "Cancelled", message: `Tool "${invocation.name}" was cancelled` });
          const started = Date.now();
          const settled = yield* entry.decode(invocation.input).pipe(
            Effect.flatMap((decoded) => hooks.invoke(ToolExecuteHook, invocation, terminal(invocation, decoded, signal, executeOptions?.update))),
            Effect.map((result) => capResult(result, options.maxResultChars)),
            // Handler failures, invalid input, and denials are results the model reads and can act on. A core shutting
            // down is not one: a defect, which the caller (the agent leaves its turn to resume) can tell apart.
            Effect.catch((error) => (error._tag === "CoreClosed" ? Effect.die(error) : Effect.succeed(errorResult(error.message)))),
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
        snapshot: Effect.map(Effect.all([added, registries.items(Guards)]), ([tools, guards]) => ({
          tools: tools.map(({ item, pluginId }) => ({ name: item.name, plugin: pluginId, description: item.description })),
          guards: guards.map(({ item, pluginId }) => ({ tool: item.tool, plugin: pluginId })),
        })),
      })
      .pipe(Effect.ignore);

    return { list, execute } satisfies Service;
  });
