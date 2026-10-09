import { Cause, Effect, Fiber, Layer, Stream } from "effect";
import type { Context } from "effect";
import { HOST_API, HostApi, HostControl, Interaction, Notice, Paths, PluginsChanged } from "@lemma/contracts/runtime";
import { Events } from "@lemma/core";
import type { ApplicationServices, Loader, ReportedFault } from "@lemma/core";
import { interactionLayer } from "./interaction.ts";
import type { PathsService } from "./paths.ts";

/*
 * The host runtime: what the host provides its plugins itself (`provide` on
 * the loader), rather than through a plugin. It is not a plugin, so its
 * failures are no plugin's faults: what it starts catches and logs its own.
 */

export type HostControlService = Context.Service.Shape<typeof HostControl>;
/** The loader handle main.ts builds; the runtime adds `runtime` and the `PluginsChanged` its changes publish. */
export type HostControlHandle = Omit<HostControlService, "runtime">;

/** The host API version this host provides (see `HostApi`); a plugin written for another is left out. */
const Api = HostApi(HOST_API);

/** What the host provides itself. No plugin may provide one; any may require one. */
export const runtimeCapabilities = [Paths, HostControl, Interaction, Api] as const;

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
export function hostRuntime(options: { readonly paths: PathsService; readonly control: HostControlHandle }): ApplicationServices<typeof runtimeCapabilities> {
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
        plugins: control.plugins,
        composition: control.composition,
        restart: (pluginId, options) => detached(control.restart(pluginId, options).pipe(Effect.ensuring(changed))),
        // A failed reload leaves the composition untouched; a report may still carry dispose faults.
        reload: detached(control.reload.pipe(Effect.tap(() => changed))),
        configure: (plugins, options) => detached(control.configure(plugins, options).pipe(Effect.ensuring(changed))),
        ui: control.ui,
        configureUi: control.configureUi,
        ...(control.configureBundles === undefined
          ? {}
          : { configureBundles: (bundles, options) => detached(control.configureBundles!(bundles, options).pipe(Effect.ensuring(changed))) }),
      } satisfies HostControlService;
    }),
  );
  return {
    provides: runtimeCapabilities,
    layer: Layer.mergeAll(Layer.succeed(Paths, options.paths), Layer.succeed(Api, HOST_API), hostControl, interactionLayer),
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
