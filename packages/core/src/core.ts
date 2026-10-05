import { Effect, Either } from "effect";
import type { Duration, Scope, Stream } from "effect";
import type { CompositionError, CoreClosed, PluginFault, ReloadError, ReportedFault, ShutdownTimeout } from "./errors.ts";
import type { Events } from "./events.ts";
import type { Hooks } from "./hooks.ts";
import type { EventSnapshot } from "./internal/events.ts";
import type { HookSnapshot } from "./internal/hooks.ts";
import type { RegistrySnapshot } from "./internal/registries.ts";
import type { Registries } from "./registries.ts";
import { plan } from "./internal/graph.ts";
import { makeRuntime } from "./internal/runtime.ts";
import type { Deadlines, Identifiers, Plugin } from "./plugin.ts";

/**
 * Lifecycle, distinct from health. "draining" no longer admits work while
 * in-flight work finishes; "failed" is stopped after a fault and stays so until
 * restarted by policy or explicitly.
 */
export type PluginState = "pending" | "activating" | "active" | "draining" | "closed" | "failed";

export interface PluginSnapshot {
  readonly id: string;
  readonly version?: string;
  readonly state: PluginState;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  /** Latest framework-reported fault of this instance, including optional work and observers. */
  readonly fault?: PluginFault;
  /** Set on a plugin stopped because this dependency failed; restarting it restarts this. */
  readonly haltedBy?: string;
}

export interface CoreSnapshot {
  readonly state: "active" | "closing" | "closed";
  /** Latest reported sequence, including retired instances; zero before the first fault. */
  readonly faultSequence: number;
  /** Retained even if cleanup subsequently finishes. */
  readonly shutdownFault?: ShutdownTimeout;
  /** Dependency order; independent plugins use code-unit id order. */
  readonly plugins: readonly PluginSnapshot[];
  readonly hooks: readonly HookSnapshot[];
  readonly events: readonly EventSnapshot[];
  /** Who contributes what, per registry. */
  readonly registries: readonly RegistrySnapshot[];
}

export interface CoreOptions {
  /** Config per plugin id, decoded with each plugin's schema before any activation. */
  readonly configs?: Readonly<Record<string, unknown>>;
  /** Applied to plugins that declare none. Defaults: activate 30s, dispose 10s. */
  readonly deadlines?: Deadlines;
  /** Total closing-caller wait; defaults to the core dispose deadline (10s). Cleanup continues on timeout. */
  readonly shutdownTimeout?: Duration.DurationInput;
}

export interface RestartOptions {
  /** Also replace an active plugin (and restart its dependents), as a config change would. Default false. */
  readonly force?: boolean;
}

export interface Core<Capabilities = never> {
  /**
   * Provide the composition to an Effect, preserving other caller requirements.
   * Work is interrupted and awaited before plugins are disposed. Caller interruption
   * also interrupts this work. No additional Effect runtime is created.
   */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | CoreClosed, Exclude<R, Capabilities | Hooks | Events | Registries>>;
  readonly inspect: Effect.Effect<CoreSnapshot>;
  /** Ordered live faults; retains 256 entries, dropping oldest without blocking. Sequence gaps reveal loss. */
  readonly faults: Stream.Stream<ReportedFault>;
  /** Reactivate a failed plugin and the dependents it halted. Active plugins are left alone unless `force` is set. */
  readonly restart: (pluginId: string, options?: RestartOptions) => Effect.Effect<void, ReloadError | CoreClosed>;
}

/**
 * Mount a fixed composition in the caller's Scope. Validation precedes activation;
 * failed/interrupted activation unwinds immediately, even if the caller catches it.
 * Close the owning scope to interrupt work, then dispose plugins in reverse order.
 */
export function makeCore<const Plugins extends readonly Plugin[]>(
  plugins: Plugins,
  options: CoreOptions = {},
): Effect.Effect<Core<Identifiers<Plugins[number]["provides"]>>, CompositionError | PluginFault, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* makeRuntime(options);
    const members = plugins.map((plugin) => {
      const config = options.configs?.[plugin.id];
      return { plugin, ...(config === undefined ? {} : { config }) };
    });
    yield* runtime.apply(members).pipe(
      Effect.mapError((error) => (error._tag === "PlanError" ? error.errors[0] : error)),
      // A composition that never activated leaves nothing behind in the caller's scope.
      Effect.onError(() => runtime.shutdown),
    );
    return runtime.core;
  });
}

/**
 * What planning would refuse in this set of plugins, found without running any
 * of them: invalid or duplicate ids, competing providers, reserved or missing
 * capabilities, cycles, and configs their Schemas reject. Empty when it would
 * plan. An application decides from it what to leave out before starting.
 */
export function checkComposition(plugins: readonly Plugin[], configs: Readonly<Record<string, unknown>> = {}): readonly CompositionError[] {
  return Either.match(
    plan(plugins, (id) => configs[id]),
    { onLeft: (errors) => errors, onRight: () => [] },
  );
}
