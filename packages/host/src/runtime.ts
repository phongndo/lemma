import { Cause, Effect, Fiber, Layer, Queue, Stream } from "effect";
import type { Context } from "effect";
import { HOST_API, HostApi, HostControl, Interaction, Notice, Paths, PluginsChanged, Trace } from "@lemma/contracts";
import { Events, reportUnhandled } from "@lemma/core";
import type { ApplicationServices, Loader, ReportedFault, SpanCollector } from "@lemma/core";
import type { CompositionHistory } from "@lemma/composition";
import type { SpanRecord } from "@lemma/contracts";
import { interactionLayer } from "./interaction.ts";
import type { PathsService } from "./paths.ts";

/*
 * The host runtime: what the host provides its plugins itself (`provide` on
 * the loader), rather than through a plugin. It is not a plugin, so its
 * failures are no plugin's faults: what it starts catches and logs its own.
 */

/** How many batches of ended spans a trace's reader may fall behind by before the oldest are dropped. */
const ENDED_BATCHES = 1024;

export type HostControlService = Context.Service.Shape<typeof HostControl>;
/** The loader handle main.ts builds; the runtime adds `runtime` and the `PluginsChanged` its changes publish. */
export type HostControlHandle = Omit<HostControlService, "runtime">;

/** The host API version this host provides (see `HostApi`); a plugin written for another is left out. */
const Api = HostApi(HOST_API);

/** What the host provides itself. No plugin may provide one; any may require one. */
export const runtimeCapabilities = [Paths, HostControl, Interaction, Trace, Api] as const;

/** Logs what failed, keeping an interruption one. */
const logFailure =
  (what: string) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.sync(() => {
          console.error(`lemma: ${what}\n${Cause.pretty(cause)}`);
        });

/**
 * The host runtime for the loader's `provide`: `Paths` as resolved,
 * `HostControl` over `control`, `Interaction` over the core's hooks, and the
 * host API version. `HostControl` publishes `PluginsChanged` after every
 * change made through it, so clients refresh: after a reload, and after a
 * restart or configure even when it fails (a failed restart can leave
 * dependents failed; a rejected configure can leave a stopped exclusive plugin
 * down). Each change runs to its end on its own fiber, publishing then: a
 * caller that stops waiting, as a stream does when the change restarts its
 * plugin, neither stops it nor keeps clients from hearing it.
 */
export function hostRuntime(options: {
  readonly paths: PathsService;
  readonly control: HostControlHandle;
  /** What `Trace` reads: the spans the host's program ends, and its composition's changes. */
  readonly trace: { readonly spans: SpanCollector; readonly changes: CompositionHistory };
}): ApplicationServices<typeof runtimeCapabilities> {
  const { control } = options;
  const runtime = runtimeCapabilities.map((tag) => tag.key);
  const hostControl = Layer.effect(
    HostControl,
    Effect.gen(function* () {
      const events = yield* Events;
      // The runtime's scope, closed once the last plugin is disposed: a change still running then ends with the core.
      const scope = yield* Effect.scope;
      const changed = Effect.flatMap(control.plugins, (plugins) => events.publish(PluginsChanged, { plugins })).pipe(
        Effect.catchCause(logFailure("could not publish the plugin list")),
      );
      const detached = <A, E>(change: Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.flatMap(Effect.forkIn(change, scope), Fiber.join);
      return {
        runtime,
        process: control.process,
        plugins: control.plugins,
        composition: control.composition,
        restart: (pluginId, options) => detached(control.restart(pluginId, options).pipe(Effect.ensuring(changed))),
        // A failed reload leaves the composition untouched; a report may still carry dispose faults.
        reload: detached(control.reload.pipe(Effect.tap(() => changed))),
        configure: (plugins, options) => detached(control.configure(plugins, options).pipe(Effect.ensuring(changed))),
        web: control.web,
      } satisfies HostControlService;
    }),
  );
  const { spans, changes } = options.trace;
  const trace = Layer.succeed(Trace, {
    spans: Effect.sync(spans.spans),
    // A reader that stops pulling (a stalled socket) holds the newest batches only, not every span the host ends.
    ended: Stream.callback<readonly SpanRecord[]>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => spans.subscribe((batch) => void Queue.offerUnsafe(queue, batch))),
          (stop) => Effect.sync(stop),
        ),
      { bufferSize: ENDED_BATCHES, strategy: "sliding" },
    ),
    changes: Effect.sync(changes.get),
  });
  return {
    provides: runtimeCapabilities,
    layer: Layer.mergeAll(Layer.succeed(Paths, options.paths), Layer.succeed(Api, HOST_API), hostControl, interactionLayer, trace),
  };
}

/**
 * Reports each fault of `loader`'s plugins until it closes: records it in
 * `history` first, so the plugin list published next already has it, logs
 * it, then publishes an error `Notice` from the plugin and `PluginsChanged`.
 * The log is the durable record; events are losable. Subscribing is the first
 * thing it does, so forked with `startImmediately` it hears every fault raised
 * after the fork. Never fails: a fault it cannot publish is logged.
 */
export const reportFaults = (loader: Loader, history: { readonly record: (fault: ReportedFault) => void }): Effect.Effect<void> =>
  Stream.runForEach(loader.core.faults, (fault) =>
    Effect.gen(function* () {
      history.record(fault);
      console.error(`lemma: ${fault.message}\n${Cause.pretty(fault.cause)}`);
      const { events, control } = yield* loader.core.run(Effect.all({ events: Events, control: HostControl }));
      yield* events.publish(Notice, { level: "error", source: fault.pluginId, message: `${fault.message}: ${Cause.pretty(fault.cause)}` });
      yield* events.publish(PluginsChanged, { plugins: yield* control.plugins });
    }).pipe(Effect.catchCause(logFailure(`could not report a fault of "${fault.pluginId}"`))),
  ).pipe(Effect.catchCause(logFailure("stopped reporting plugin faults")));

/**
 * Keeps a plugin's error nothing handled from ending the host. One raised by a plugin's work (a stray timer or promise)
 * is that plugin's fault (`reportUnhandled`), reported as its others are, and it and every session keep running; a call
 * a stopped plugin made, refused, is expected and dropped; one from no plugin's work that can be told ends the host, as
 * Node.js would. Returns the removal.
 */
export const catchUnhandled = (): (() => void) => {
  const unhandled = (error: unknown) => {
    const whose = reportUnhandled(error);
    if (whose.kind === "stopped") return;
    // Logged even as a plugin's fault: one whose plugin has stopped records no fault, and would be lost.
    console.error(
      `lemma: ${whose.kind === "fault" ? `[${whose.pluginId}] an error its work did not handle` : "an error nothing handled"}\n${Cause.pretty(Cause.die(error))}`,
    );
    // No plugin's: the host's own state may be broken, so it ends as Node would end it.
    if (whose.kind === "unknown") process.exit(1);
  };
  process.on("unhandledRejection", unhandled);
  process.on("uncaughtException", unhandled);
  return () => {
    process.off("unhandledRejection", unhandled);
    process.off("uncaughtException", unhandled);
  };
};
