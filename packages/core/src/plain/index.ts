import { Cause, Context, Effect, Scope, Tracer } from "effect";
import type { Schema } from "effect";
import { awaitable, EffectOf, inContext, isExpectedFailure, settle } from "../awaitable.ts";
import { PluginStopped } from "../errors.ts";
import type { Awaitable } from "../awaitable.ts";
import type { ConfigInput, ConfigOf } from "../config.ts";
import type { CoreClosed, HookError } from "../errors.ts";
import { Events } from "../events.ts";
import type { Event, ObserveOptions } from "../events.ts";
import { Hooks, PluginContext } from "../hooks.ts";
import type { BackgroundOptions, FaultOptions, Hook, HookOptions, Next, PluginIdentity } from "../hooks.ts";
import { definePlugin as defineSetup } from "../plugin.ts";
import type { Capabilities, Plugin, PluginManifest, Provided } from "../plugin.ts";
import { Registries } from "../registries.ts";
import type { ContributeOptions, Contribution, Registry } from "../registries.ts";
import { makeBridge } from "./bridge.ts";
import type { Bridge } from "./bridge.ts";
import { followsAwait, within } from "../internal/current.ts";
import type { Current } from "../internal/current.ts";
import { plainView } from "./view.ts";
import type { Plain } from "./view.ts";

export { awaitable, fail } from "../awaitable.ts";
export type { Awaitable } from "../awaitable.ts";
export { configSchema } from "../config.ts";
export { PluginStopped } from "../errors.ts";
export { Event } from "../events.ts";
export { Hook } from "../hooks.ts";
export { Registry } from "../registries.ts";
export type { Plain } from "./view.ts";
export { followsAwait };

/** The services behind named capabilities, as promise-based code uses them. */
export type PlainServices<C extends Capabilities> = { readonly [K in keyof C]: Plain<Context.Service.Shape<C[K]>> };

/**
 * Around middleware written with promises: change the input, wrap what
 * `next` resolves to, or return without calling it. Return `next(input)`
 * from a function that is not `async` to pass straight through without
 * leaving the caller's fiber. A handler that declares `signal` receives one,
 * aborted if the operation is interrupted.
 */
export type PlainHandler<I, O, E> = (input: I, next: (input: I) => Promise<O>, signal: AbortSignal) => Awaitable<O, E | HookError | CoreClosed>;

/** What a promise-based `setup` receives besides its services. */
export interface PlainSetup<Config, Carried = unknown> extends PluginIdentity {
  /** Decoded from the plugin's `config`. */
  readonly config: Config;
  /**
   * What the instance it replaces handed over (`handoff`), decoded by `carry`
   * when it has one: state that survives a reload or a config change.
   * Undefined on a first start, after a failure, or when it no longer decodes.
   */
  readonly previous: Carried | undefined;
  /**
   * Hands state to this plugin's replacement: `save` runs when a replacement
   * starts (see `PluginContext.handoff`), and returns its `previous`.
   */
  readonly handoff: (save: () => Carried) => void;
  /** Aborted when the plugin stops, before its cleanups run: hand it to work it starts. */
  readonly signal: AbortSignal;
  /** Runs when the plugin stops, after its signal aborts; the last added runs first, and each runs even if another throws. */
  readonly onCleanup: (cleanup: () => void | PromiseLike<void>) => void;
  /** Intercepts a hook's operation; removed when the plugin stops. */
  readonly on: <I, O, E>(hook: Hook<I, O, E>, handler: PlainHandler<I, O, E>, options?: HookOptions) => void;
  /** Contributes an item to a registry; returns its removal. It also leaves when the plugin stops. */
  readonly add: <I>(registry: Registry<I>, item: I, options?: ContributeOptions) => () => void;
  /** Observes an event; a failure is reported as this plugin's fault and affects nothing else. */
  readonly observe: <P>(event: Event<P>, observer: (payload: P, signal: AbortSignal) => Awaitable<void, unknown>, options?: ObserveOptions) => void;
  /** Publishes an event; it never fails and never waits. */
  readonly publish: <P>(event: Event<P>, payload: P) => void;
  /** Runs a hook's operation this plugin owns: the handlers, then `terminal`. */
  readonly invoke: <I, O, E>(hook: Hook<I, O, E>, input: I, terminal: (input: I, signal: AbortSignal) => Awaitable<O, E>) => Promise<O>;
  /** A registry's items now, in order. */
  readonly items: <I>(registry: Registry<I>) => readonly Contribution<I>[];
  /** A registry's items now, then after each change, until the plugin stops; a slow reader sees the latest. */
  readonly changes: <I>(registry: Registry<I>) => AsyncIterable<readonly Contribution<I>[]>;
  /**
   * Runs supervised work owned by the plugin: its failure is reported as the
   * plugin's fault, and with `required` fails the plugin. Its signal aborts
   * when the plugin stops. Start long-running work here, not by leaving a
   * promise behind in `setup`, which waits for the calls it makes.
   */
  readonly background: (name: string, task: (signal: AbortSignal) => Awaitable<unknown, unknown>, options?: BackgroundOptions) => void;
  /** Reports a failure of the plugin's own work the core does not run (a callback a library calls); with `fatal`, the plugin fails. */
  readonly fault: (operation: string, error: unknown, options?: FaultOptions) => void;
  /** Runs an Effect with the plugin's context, as a step towards writing it with Effects. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;
}

export interface PlainDefinition<
  Requires extends Capabilities,
  Provides extends Capabilities,
  C extends ConfigInput | undefined,
  Carried = unknown,
> extends PluginManifest {
  /** A Schema, or the defaults one is derived from (`{ limit: 3 }`). */
  readonly config?: C;
  /** Checks what a previous instance handed over before setup sees it as `previous` (see `SetupDefinition.carry`). */
  readonly carry?: Schema.Codec<Carried, any>;
  /** Capabilities it uses, by the names `setup` receives them under. */
  readonly requires?: Requires;
  /** Capabilities it provides, by the names `setup` returns them under. */
  readonly provides?: Provides;
  /**
   * Runs once when the plugin activates; may be `async`. Returns the services
   * it provides, as their contracts declare them (`asEffect` turns an async
   * function into one returning an Effect). It is active once setup has
   * returned and every call it made has settled: a call that failed, or a
   * throw, fails its activation, attributed to it.
   */
  readonly setup: (
    services: PlainServices<NoInfer<Requires>>,
    plugin: PlainSetup<ConfigOf<NoInfer<C>>, NoInfer<Carried>>,
  ) => Provided<NoInfer<Provides>> | PromiseLike<Provided<NoInfer<Provides>>>;
}

/**
 * For an application that writes plugins its own way on top of these (a UI
 * framework's): how `setup` receives its services, and what it runs inside.
 */
export interface Embedding {
  /**
   * `"plain"` (the default): as `Plain<S>`, refused once the plugin stops.
   * `"raw"`: as provided, for contracts that are promise-based already.
   * A function: the embedder's own view, given the plugin's `PluginContext`.
   */
  readonly services?:
    | "plain"
    | "raw"
    | ((services: Readonly<Record<string, unknown>>, owner: Context.Service.Shape<typeof PluginContext>) => Record<string, unknown>);
  /** Runs `setup` (it calls the plugin's), inside whatever the embedder needs: a reactive root, an error boundary. */
  readonly run?: <T>(setup: () => T, plugin: PlainSetup<unknown>) => T;
}

/**
 * A function returning a promise as one returning an Effect, for providing a
 * contract whose methods return Effects. A rejection is a defect unless its
 * error was marked with `fail`.
 *
 *   return { store: { get: asEffect(async (key: string) => cache.get(key) ?? (await load(key))) } };
 */
export const asEffect =
  <Args extends readonly unknown[], A, E = never>(fn: (...args: Args) => Awaitable<A, E>) =>
  (...args: Args): Effect.Effect<A, E> =>
    awaitable(() => fn(...args));

/** A hook's `next` for promise-based code: awaited, it runs the rest of the chain; returned as it is, the chain runs in place. */
class PlainNext<O> implements PromiseLike<O> {
  readonly [EffectOf]: Effect.Effect<O, unknown>;
  private readonly bridge: Bridge;
  private readonly current: Current;
  private readonly operation: string;
  private started: Promise<O> | undefined;
  constructor(effect: Effect.Effect<O, unknown>, bridge: Bridge, current: Current, operation: string) {
    this[EffectOf] = effect;
    this.bridge = bridge;
    this.current = current;
    this.operation = operation;
  }
  private promise(): Promise<O> {
    return (this.started ??= within(this.current, () => this.bridge.run(this[EffectOf], this.operation)));
  }
  // Awaiting `next(input)` is how a promise-based handler runs the rest of the chain: it must be a thenable.
  // oxlint-disable-next-line unicorn/no-thenable
  then<T1 = O, T2 = never>(
    onFulfilled?: ((value: O) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.promise().then(onFulfilled, onRejected);
  }
  catch<T = never>(onRejected?: ((reason: unknown) => T | PromiseLike<T>) | null): Promise<O | T> {
    return this.promise().catch(onRejected);
  }
  finally(onFinally?: (() => void) | null): Promise<O> {
    return this.promise().finally(onFinally);
  }
}

/**
 * A plugin written with promises: named services in, as promise-based views
 * (`Plain<S>`); named services out; a `setup` that may be `async`. The same
 * plugin to the core as one written with Effects, planned, ordered,
 * supervised, and replaced alike, with the same guarantees: what it registers
 * leaves when it stops, its failures are its faults, and its services refuse
 * calls once it has stopped, so a timer or promise it left behind cannot act
 * through them.
 *
 *   export default definePlugin({
 *     id: "greeter",
 *     config: { greeting: "Hello" },
 *     requires: { names: Names },
 *     setup: async ({ names }, { config, on }) => {
 *       const known = await names.list();
 *       on(Greet, (name, next) => (known.includes(name) ? `${config.greeting}, ${name}` : next(name)));
 *     },
 *   });
 */
export function definePlugin<
  const Requires extends Capabilities = {},
  const Provides extends Capabilities = {},
  C extends ConfigInput | undefined = undefined,
  Carried = unknown,
>(definition: PlainDefinition<Requires, Provides, C, Carried>, embedding: Embedding = {}): Plugin<readonly Provides[keyof Provides][]> {
  const { setup, ...manifest } = definition;
  return defineSetup({
    ...(manifest as Omit<PlainDefinition<Requires, Provides, C, Carried>, "setup">),
    setup: (
      services: Readonly<Record<string, unknown>>,
      owner: Omit<Context.Service.Shape<typeof PluginContext>, "previous"> & {
        readonly config: unknown;
        readonly signal: AbortSignal;
        readonly previous: unknown;
      },
    ) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks;
        const events = yield* Events;
        const registries = yield* Registries;
        // Calls made later, outside any invocation, run with the plugin's context; not under its activation's span.
        const base = Context.omit(Tracer.ParentSpan)(yield* Effect.context<never>()) as Context.Context<never>;
        const bridge = makeBridge({
          pluginId: owner.id,
          base,
          own: [PluginContext, Scope.Scope].map((key) => ({
            key: key as Context.Key<unknown, unknown>,
            value: Context.getOrUndefined(base, key as Context.Key<unknown, unknown>),
          })),
          signal: owner.signal,
          report: (operation, cause) => void Effect.runFork(owner.fault(operation, cause)),
        });
        const cleanups: (() => void | PromiseLike<void>)[] = [];
        // Added before anything it registers, so it runs after those are removed and after its signal aborts; its
        // services work while it runs, and are refused once it is done.
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            // Its signal has aborted (work it started stops); what cleanup calls runs on, until cleanup is done.
            bridge.beginCleanup();
            const errors: unknown[] = [];
            try {
              for (const cleanup of cleanups.splice(0).reverse()) {
                try {
                  await within({ context: base, invocation: undefined }, cleanup);
                } catch (error) {
                  errors.push(error);
                }
              }
            } finally {
              bridge.endCleanup();
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, `${errors.length} cleanups of "${owner.id}" failed`);
          }),
        );
        const plugin = context(owner, bridge, hooks, events, registries, cleanups);
        const raw = services as Readonly<Record<string, unknown>>;
        const view =
          embedding.services === "raw"
            ? raw
            : typeof embedding.services === "function"
              ? embedding.services(raw, owner)
              : Object.fromEntries(Object.entries(raw).map(([name, service]) => [name, plainView(service, bridge, name)]));
        const run = () => setup(view as PlainServices<Requires>, plugin as PlainSetup<ConfigOf<C>, Carried>);
        // Setup runs in the plugin's own context (a timer it starts does not trace under an activation long over),
        // recording the calls it makes: it is active once they have settled, and a registration that failed fails it.
        // Work it starts elsewhere (a background task) is not waited for.
        const calls = bridge.startSetup();
        const provided = yield* settle(
          () => (embedding.run === undefined ? run() : embedding.run(run, plugin as PlainSetup<unknown>)),
          (invocation, enter) => within({ context: base, invocation, setup: calls }, enter),
        ).pipe(
          Effect.tap(() => awaitable(() => bridge.endSetup(calls))),
          Effect.ensuring(
            Effect.sync(() => {
              calls.open = false;
            }),
          ),
        );
        return provided as Provided<Provides>;
      }),
  } as never) as Plugin<readonly Provides[keyof Provides][]>;
}

const context = (
  owner: Omit<Context.Service.Shape<typeof PluginContext>, "previous"> & { readonly config: unknown; readonly signal: AbortSignal; readonly previous: unknown },
  bridge: Bridge,
  hooks: Context.Service.Shape<typeof Hooks>,
  events: Context.Service.Shape<typeof Events>,
  registries: Context.Service.Shape<typeof Registries>,
  cleanups: (() => void | PromiseLike<void>)[],
): PlainSetup<unknown> => {
  const causeOf = (error: unknown) => (isExpectedFailure(error) ? Cause.fail(error) : Cause.die(error));
  return {
    id: owner.id,
    ...(owner.version === undefined ? {} : { version: owner.version }),
    config: owner.config,
    signal: owner.signal,
    previous: owner.previous,
    handoff: (save) => Effect.runSync(owner.handoff(save)),
    onCleanup: (cleanup) => void cleanups.push(cleanup),
    on: (hook, handler, options) => {
      const wantsSignal = handler.length >= 3;
      const nextOperation = `${hook.name} next`;
      const register = owner.on(
        hook,
        (input, next: Next<any, any, any>) =>
          Effect.withFiber((fiber) => {
            const context = fiber.context as Context.Context<never>;
            return settle(
              (invocation) => {
                const current = { context, invocation };
                const plainNext = (value: unknown) => new PlainNext(next(value), bridge, current, nextOperation);
                return handler(input, plainNext as never, (wantsSignal ? invocation.signal() : undefined) as AbortSignal);
              },
              (invocation, run) => within({ context, invocation }, run),
            );
          }) as never,
        options,
      );
      void bridge.run(register, `on ${hook.name}`);
    },
    add: (registry, item, options) => {
      const added = bridge.run(owner.add(registry, item, options), `add ${registry.name}`);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        void added.then(
          (remove) => (bridge.stopped() ? undefined : bridge.run(remove, `remove ${registry.name}`)),
          () => undefined,
        );
      };
    },
    observe: (event, observer, options) => {
      const wantsSignal = observer.length >= 2;
      const register = owner.observe(
        event,
        (payload) => inContext((invocation) => observer(payload, (wantsSignal ? invocation.signal() : undefined) as AbortSignal)),
        options,
      );
      void bridge.run(register, `observe ${event.name}`);
    },
    // A stopped plugin's news is dropped: publishing never fails.
    publish: (event, payload) => void (bridge.stopped() ? undefined : Effect.runFork(events.publish(event, payload))),
    invoke: (hook, input, terminal) => {
      const wantsSignal = terminal.length >= 2;
      return bridge.run(
        hooks.invoke(hook, input, (value) => inContext((invocation) => terminal(value, (wantsSignal ? invocation.signal() : undefined) as AbortSignal))),
        `invoke ${hook.name}`,
      );
    },
    items: (registry) => {
      if (bridge.stopped()) throw new PluginStopped({ pluginId: owner.id, operation: `items ${registry.name}` });
      return Effect.runSync(registries.items(registry));
    },
    changes: (registry) => bridge.iterate(registries.changes(registry), `changes ${registry.name}`),
    background: (name, task, options) =>
      void bridge.run(
        owner.background(
          name,
          inContext((invocation) => task(invocation.signal())),
          options,
        ),
        `background ${name}`,
      ),
    fault: (operation, error, options) => void Effect.runFork(owner.fault(operation, causeOf(error), options)),
    run: (effect) => bridge.run(effect, "run"),
  };
};
