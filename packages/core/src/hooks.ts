import { Context, Effect } from "effect";
import type { Cause } from "effect";
import type { CoreClosed, EventError, HookError, RegistryError } from "./errors.ts";
import type { Event, Observer, ObserveOptions } from "./events.ts";
import type { ContributeOptions, Registry } from "./registries.ts";
import { checkPhases } from "./internal/phases.ts";
import { token } from "./internal/tokens.ts";

const HookTypeId: unique symbol = Symbol("@lemma/core/Hook");

/**
 * An interception point: around middleware on an operation's critical path.
 * A failing handler fails the operation (fail closed), so a gate that crashes
 * is never skipped. Share this token with contributors; a name may identify
 * only one token per core.
 */
export interface Hook<Input, Output, Error = never> extends PhaseOptions {
  readonly name: string;
  readonly summary?: HookSummary<Input, Output>;
  readonly check?: HookCheck;
  readonly [HookTypeId]: {
    readonly input: (_: Input) => Input;
    readonly output: (_: Output) => Output;
    readonly error: (_: Error) => Error;
  };
}

/** A few plain values describing a hook's input or output (counts, names), for a trace: never the payload. */
export type Summary = Readonly<Record<string, string | number | boolean>>;

/**
 * What a trace shows of each handler of a hook: its input (`hook.in.*` on its span), what it passed on (`hook.next.*`),
 * and its output (`hook.out.*`). Asked only while tracing is on.
 */
export interface HookSummary<Input, Output> {
  readonly input?: (input: Input) => Summary;
  readonly output?: (output: Output) => Summary;
}

/**
 * What a hook checks of its handlers at run time, for handlers TypeScript never saw (a plugin written in JavaScript):
 * `input`, what a handler hands `next`; `output`, what a handler returns. Each answers a one-line problem, or
 * `undefined` when the value is fine. A problem fails the operation with `HookError` (`InvalidInput`,
 * `InvalidOutput`) naming the handler's plugin, so a wrong shape is the plugin's fault where it was made, not a crash
 * further on. The value the hook's own caller passes in, and its terminal's result, are not checked.
 */
export interface HookCheck {
  readonly input?: (value: unknown) => string | undefined;
  readonly output?: (value: unknown) => string | undefined;
}

/**
 * Named places in order, which a token's owner declares (a hook's for its handlers, a registry's for its items): a
 * contributor names the one it belongs in (`phase`), and comes after everything in an earlier phase and before
 * everything in a later one, whatever their `order`, which orders it within its phase. So a handler that must see what
 * every other has made (compaction, sizing the request they shaped) says so, rather than guessing a number above
 * theirs. One that names no phase goes in `defaultPhase`. A token without phases orders by `order` alone.
 */
export interface PhaseOptions {
  /** The phases, first first. Each named once; with them, a `defaultPhase` among them. */
  readonly phases?: readonly string[];
  readonly defaultPhase?: string;
}

export const Hook = {
  /** Throws when `phases` cannot order anything: none, one named twice, or no `defaultPhase` among them. */
  make<Input, Output, Error = never>(
    name: string,
    options?: { readonly summary?: HookSummary<Input, Output>; readonly check?: HookCheck } & PhaseOptions,
  ): Hook<Input, Output, Error> {
    checkPhases("Hook", name, options ?? {});
    return token(
      Object.freeze({
        name,
        ...(options?.summary === undefined ? {} : { summary: options.summary }),
        ...(options?.check === undefined ? {} : { check: Object.freeze({ ...options.check }) }),
        ...(options?.phases === undefined ? {} : { phases: Object.freeze([...options.phases]), defaultPhase: options.defaultPhase! }),
      }),
    ) as Hook<Input, Output, Error>;
  },
};

/** One handler's part in an invocation, as it ended (`InvokeOptions.onStep`). */
export interface HandlerStep<Input, Output> {
  readonly pluginId: string;
  /** Its phase, when the hook declares phases. */
  readonly phase?: string;
  readonly order: number;
  /** Its place in the chain, from 0. */
  readonly index: number;
  /** What it was handed. */
  readonly input: Input;
  /** What it handed `next`, and what that returned to it; absent when it never called `next`. */
  readonly next?: { readonly input: Input; readonly output?: Output };
  /** What it returned; absent when it failed or was interrupted. */
  readonly output?: Output;
  readonly exit: "success" | "failure" | "interrupted";
  /** Epoch milliseconds it started at. */
  readonly startedAt: number;
  /** How long it took, and how much of that was its own: without the rest of the chain it called. */
  readonly ms: number;
  readonly selfMs: number;
}

export interface InvokeOptions<Input, Output> {
  /**
   * Hears each handler's step as it ends, the innermost first: who changed what, and how long each took. What an
   * application credits a result to, kept beside it. Costs nothing when absent.
   */
  readonly onStep?: (step: HandlerStep<Input, Output>) => void;
}

export type Next<Input, Output, Error> = (input: Input) => Effect.Effect<Output, Error | HookError | CoreClosed>;

/** Around middleware: change input, wrap output, or return without calling next. */
export type Handler<Input, Output, Error, Requirements = never> = (
  input: Input,
  next: Next<Input, Output, Error>,
) => Effect.Effect<Output, Error | HookError | CoreClosed, Requirements>;

export interface HookOptions {
  /**
   * Where it runs, when the hook declares phases (see `PhaseOptions`): its `defaultPhase` when absent. Naming one the
   * hook does not declare fails with `HookError` ("InvalidOrder").
   */
  readonly phase?: string;
  /** Lower values run first, within the phase; ties use plugin id, then registration order. */
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
      options?: InvokeOptions<I, O>,
    ) => Effect.Effect<O, E | HookError | CoreClosed, R>;
    /**
     * Whether the core has shut its hooks, as it does when it shuts down, before it disposes any plugin: every `invoke`
     * fails `CoreClosed` from then on. Work that fails then can tell a failure of the shutdown from its own.
     */
    readonly closed: Effect.Effect<boolean>;
  }
>()("@lemma/core/Hooks") {}
