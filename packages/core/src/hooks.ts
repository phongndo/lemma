import { Context, Effect } from "effect";
import type { Cause } from "effect";
import type { CoreClosed, EventError, HookError, RegistryError } from "./errors.ts";
import type { Event, Observer, ObserveOptions } from "./events.ts";
import type { ContributeOptions, Registry } from "./registries.ts";
import { token } from "./internal/tokens.ts";

const HookTypeId: unique symbol = Symbol("@lemma/core/Hook");

/**
 * An interception point: around middleware on an operation's critical path.
 * A failing handler fails the operation (fail closed), so a gate that crashes
 * is never skipped. Share this token with contributors; a name may identify
 * only one token per core.
 */
export interface Hook<Input, Output, Error = never> {
  readonly name: string;
  readonly [HookTypeId]: {
    readonly input: (_: Input) => Input;
    readonly output: (_: Output) => Output;
    readonly error: (_: Error) => Error;
  };
}

export const Hook = {
  make<Input, Output, Error = never>(name: string): Hook<Input, Output, Error> {
    return token(Object.freeze({ name })) as Hook<Input, Output, Error>;
  },
};

export type Next<Input, Output, Error> = (input: Input) => Effect.Effect<Output, Error | HookError | CoreClosed>;

/** Around middleware: change input, wrap output, or return without calling next. */
export type Handler<Input, Output, Error, Requirements = never> = (
  input: Input,
  next: Next<Input, Output, Error>,
) => Effect.Effect<Output, Error | HookError | CoreClosed, Requirements>;

export interface HookOptions {
  /** Lower values run first; ties use plugin id, then registration order. */
  readonly order?: number;
}

export interface BackgroundOptions {
  /** A required task's failure fails the plugin; an optional task's failure is only reported. Default false. */
  readonly required?: boolean;
}

export interface FaultOptions {
  /** Fails the plugin (and halts its dependents), as a required background task's failure does. Default false. */
  readonly fatal?: boolean;
}

export interface PluginIdentity {
  readonly id: string;
  readonly version?: string;
}

/** Present during activation and in the environment captured by registered handlers. */
export class PluginContext extends Context.Service<
  PluginContext,
  PluginIdentity & {
    /**
     * The handler runs with this plugin's own services (what it requires, and
     * what it registered with while activating), whenever it is registered:
     * never the references or plugin of the work that registered it. Removed
     * when the plugin's scope closes.
     */
    readonly on: <I, O, E, R>(hook: Hook<I, O, E>, handler: Handler<I, O, E, R>, options?: HookOptions) => Effect.Effect<void, HookError | CoreClosed, R>;
    /**
     * Contribute an item to a registry. It is visible once this plugin is
     * published and leaves when its scope closes; the returned effect removes it
     * sooner.
     */
    readonly add: <I>(registry: Registry<I>, item: I, options?: ContributeOptions) => Effect.Effect<Effect.Effect<void>, RegistryError | CoreClosed>;
    /**
     * Observe an event, with this plugin's own services as `on` has them.
     * Failures are attributed to this plugin and isolated from everything else.
     */
    readonly observe: <P, R>(event: Event<P>, observer: Observer<P, R>, options?: ObserveOptions) => Effect.Effect<void, EventError | CoreClosed, R>;
    /**
     * Run supervised work owned by this plugin's scope. Its exit is reported as a
     * `PluginFault` (phase "background"); use this rather than a detached fiber so
     * the core can see the failure.
     */
    readonly background: <R>(name: string, work: Effect.Effect<unknown, unknown, R>, options?: BackgroundOptions) => Effect.Effect<void, CoreClosed, R>;
    /**
     * Report a failure of this plugin's own work that the core does not run (a
     * callback another library calls, a view it draws): a `PluginFault` (phase
     * "service", `operation`), and with `fatal`, the plugin fails as a required
     * background task's failure would fail it. Reporting from a plugin that has
     * stopped does nothing.
     */
    readonly fault: (operation: string, cause: Cause.Cause<unknown>, options?: FaultOptions) => Effect.Effect<void>;
    /** Attribute custom capability operations without wrapping or proxying their values. */
    readonly trace: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * What the instance this one replaces handed over (`handoff`), when this
     * activation replaces a running one: a reload, a config change, a forced
     * restart. Undefined on a first start, after a failure, and when the old
     * instance handed nothing over.
     */
    readonly previous: unknown;
    /**
     * Hands state to this plugin's replacement: `save` runs once, when a
     * replacement starts staging (an `exclusive` plugin's, just before it
     * stops), and what it returns is the replacement's `previous`. Changes after
     * that are not carried, unless the plugin is `exclusive`. A throw is
     * reported as this plugin's fault, and the replacement starts without it.
     * The latest call wins.
     */
    readonly handoff: (save: () => unknown) => Effect.Effect<void>;
  }
>()("@lemma/core/PluginContext") {}

/** Plugins define the hook tokens and terminal behavior; the core only dispatches. */
export class Hooks extends Context.Service<
  Hooks,
  {
    readonly invoke: <I, O, E, R>(
      hook: Hook<I, O, E>,
      input: I,
      terminal: (input: I) => Effect.Effect<O, E, R>,
    ) => Effect.Effect<O, E | HookError | CoreClosed, R>;
  }
>()("@lemma/core/Hooks") {}
