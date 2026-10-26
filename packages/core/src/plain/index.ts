import { Cause, Context, Deferred, Duration, Effect, Scope, Tracer } from "effect";
import { awaitable, EffectOf, inContext, isExpectedFailure, settle } from "../awaitable.ts";
import { PluginStopped } from "../errors.ts";
import type { Awaitable } from "../awaitable.ts";
import type { ConfigInput, ConfigOf } from "../config.ts";
import type { CoreClosed, HookError } from "../errors.ts";
import { Events } from "../events.ts";
import type { Event, ObserveOptions } from "../events.ts";
import { Hooks, PluginContext } from "../hooks.ts";
import type { BackgroundOptions, FaultOptions, Hook, HookOptions, InvokeOptions, Next, PluginIdentity } from "../hooks.ts";
import { definePlugin as defineSetup } from "../plugin.ts";
import type { Capabilities, Plugin, PluginManifest, Provided } from "../plugin.ts";
import { Registries } from "../registries.ts";
import type { ContributeOptions, Contribution, Registry } from "../registries.ts";
import { makeBridge } from "./bridge.ts";
import type { Bridge, RunOptions } from "./bridge.ts";
import { outside, within } from "../internal/current.ts";
import type { Current } from "../internal/current.ts";
import { plainView } from "./view.ts";
import type { Plain } from "./view.ts";

export { assert, AssertionError, Verify } from "../assert.ts";
export { awaitable, fail } from "../awaitable.ts";
export type { Awaitable } from "../awaitable.ts";
export { configSchema } from "../config.ts";
export { PluginStopped } from "../errors.ts";
export { Event } from "../events.ts";
export { Hook } from "../hooks.ts";
export { Registry } from "../registries.ts";
export type { Plain } from "./view.ts";

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

/** What `listen` attaches to: a DOM `EventTarget` (`window`, `document`, an element, a media query), or an emitter. */
export type Listenable =
  | {
      readonly addEventListener: (type: string, listener: (event: any) => void, options?: ListenOptions) => void;
      readonly removeEventListener: (type: string, listener: (event: any) => void, options?: ListenOptions) => void;
    }
  | { readonly on: (type: string, listener: (...args: any[]) => void) => unknown; readonly off: (type: string, listener: (...args: any[]) => void) => unknown };

/** As a DOM listener's options: `capture` and `passive` pass through; `once` removes it after its first call. */
export interface ListenOptions {
  readonly capture?: boolean;
  readonly passive?: boolean;
  readonly once?: boolean;
}

/** A timer's name, which its faults and traces carry: `after 500ms` and `every 1000ms` without one. */
export interface TimerOptions {
  readonly name?: string;
}

/** What a promise-based `setup` receives besides its services. */
export interface PlainSetup<Config> extends PluginIdentity {
  /** Decoded from the plugin's `config`. */
  readonly config: Config;
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
  /** Runs a hook's operation this plugin owns: the handlers, then `terminal`; `onStep` hears each handler's part. */
  readonly invoke: <I, O, E>(
    hook: Hook<I, O, E>,
    input: I,
    terminal: (input: I, signal: AbortSignal) => Awaitable<O, E>,
    options?: InvokeOptions<I, O>,
  ) => Promise<O>;
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
  /**
   * Runs `fn` in a span named `name`, attributed to the plugin (`plugin.id`), under the span of the work that called it
   * (a hook's operation, an observed event's): the calls it makes trace under it. Resolves or rejects as `fn` does.
   */
  readonly trace: <A>(name: string, fn: (signal: AbortSignal) => Awaitable<A, unknown>) => Promise<A>;
  /*
   * The helpers below are what a plugin would otherwise write with raw timers, listeners, and promises. Each is
   * supervised work of the plugin's underneath: it ends when the plugin stops, and what fails in it is the plugin's
   * fault, named for it, rather than an error nobody owns.
   */
  /** Calls `fn` once, `ms` from now, unless the plugin stops or the returned cancel runs first. */
  readonly after: (ms: number, fn: (signal: AbortSignal) => Awaitable<unknown, unknown>, options?: TimerOptions) => () => void;
  /**
   * Calls `fn` every `ms`, the first `ms` from now, until the plugin stops or the returned cancel runs. A run that fails
   * is reported and the next still comes; the next waits for the last to end, so runs never overlap.
   */
  readonly every: (ms: number, fn: (signal: AbortSignal) => Awaitable<unknown, unknown>, options?: TimerOptions) => () => void;
  /**
   * Listens to what the plugin does not own (`window`, `document`, a media query, an emitter) until it stops, or the
   * returned removal runs. The listener runs as an `action`. Once the plugin is stopping it attaches nothing, as do
   * `after` and `every`: nothing would end them.
   */
  readonly listen: <A = any>(target: Listenable, type: string, listener: (event: A) => unknown, options?: ListenOptions) => () => void;
  /**
   * Runs `fn` as the plugin's own work, its signal aborted when the plugin stops: as `background`, but resolving with
   * what `fn` resolves with, or `undefined` when it failed (its fault, named `name`) or the plugin had stopped. Setup does
   * not wait for it. Asked as the plugin stops (a cleanup's flush), it runs at once, as part of stopping.
   */
  readonly task: <A>(name: string, fn: (signal: AbortSignal) => Awaitable<A, unknown>) => Promise<A | undefined>;
  /**
   * `fn` as a callback for others to call (an event handler, a library's callback): it runs as the plugin's own work,
   * wherever it is called, and does nothing once the plugin is stopping. A throw or rejection is the plugin's fault, named
   * `name`, rather than an error nobody owns; a `PluginStopped` (a call refused as a plugin stopped) is none.
   */
  readonly action: <Args extends readonly unknown[]>(name: string, fn: (...args: Args) => unknown) => (...args: Args) => void;
}

export interface PlainDefinition<Requires extends Capabilities, Provides extends Capabilities, C extends ConfigInput | undefined> extends PluginManifest {
  /** A Schema, or the defaults one is derived from (`{ limit: 3 }`). */
  readonly config?: C;
  /** Capabilities it uses, by the names `setup` receives them under. */
  readonly requires?: Requires;
  /** Capabilities it provides, by the names `setup` returns them under. */
  readonly provides?: Provides;
  /**
   * Runs once when the plugin activates; may be `async`. Returns the services
   * it provides, as their contracts declare them. It is active once setup has
   * returned and every call it made has settled: a call that failed, or a
   * throw, fails its activation, attributed to it.
   */
  readonly setup: (
    services: PlainServices<NoInfer<Requires>>,
    plugin: PlainSetup<ConfigOf<NoInfer<C>>>,
  ) => Provided<NoInfer<Provides>> | PromiseLike<Provided<NoInfer<Provides>>>;
}

/**
 * For an application that writes plugins its own way on top of these (a UI
 * framework's): how `setup` receives its services, and what it runs inside.
 */
export interface Embedding {
  /**
   * `"plain"` (the default): as `Plain<S>`, refused once the plugin stops.
   * A function: the embedder's own view, given the plugin's `PluginContext` and its signal, aborted as it stops.
   */
  readonly services?:
    | "plain"
    | ((
        services: Readonly<Record<string, unknown>>,
        owner: Context.Service.Shape<typeof PluginContext> & { readonly signal: AbortSignal },
      ) => Record<string, unknown>);
  /** Runs `setup` (it calls the plugin's), inside whatever the embedder needs: a reactive root, an error boundary. */
  readonly run?: <T>(setup: () => T, plugin: PlainSetup<unknown>) => T;
}

/** Effect work promise-based code starts, outside its invocation (see `outside`): what it leaves running is not that code's. */
const runFork = <A, E>(effect: Effect.Effect<A, E>) => outside(() => Effect.runFork(effect));
const runSync = <A, E>(effect: Effect.Effect<A, E>): A => outside(() => Effect.runSync(effect));

/**
 * What a plugin registers (a handler, an observer, an item, a background
 * task) is the plugin's, not the work's that was running when it registered:
 * it runs in the plugin's own context, so it never keeps that work's
 * references (who asked, which trace) for later callers.
 */
const BELONGS_TO_PLUGIN: RunOptions = { context: "plugin" };

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
    // The rest of the chain is the caller's: it runs in the operation's context, not as this handler's plugin.
    return (this.started ??= within(this.current, () => this.bridge.run(this[EffectOf], this.operation, { own: false })));
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
export function definePlugin<const Requires extends Capabilities = {}, const Provides extends Capabilities = {}, C extends ConfigInput | undefined = undefined>(
  definition: PlainDefinition<Requires, Provides, C>,
  embedding: Embedding = {},
): Plugin<readonly Provides[keyof Provides][]> {
  const { setup, ...manifest } = definition;
  return defineSetup({
    ...(manifest as Omit<PlainDefinition<Requires, Provides, C>, "setup">),
    setup: (
      services: Readonly<Record<string, unknown>>,
      owner: Context.Service.Shape<typeof PluginContext> & { readonly config: unknown; readonly signal: AbortSignal },
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
          report: (operation, cause) => void runFork(owner.fault(operation, cause)),
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
              // What cleanups acquired is released once they are all done.
              await bridge.endCleanup().catch((error: unknown) => void errors.push(error));
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, `${errors.length} cleanups of "${owner.id}" failed`);
          }),
        );
        const plugin = context(owner, bridge, hooks, events, registries, cleanups, base);
        const raw = services as Readonly<Record<string, unknown>>;
        const view =
          typeof embedding.services === "function"
            ? embedding.services(raw, owner)
            : Object.fromEntries(Object.entries(raw).map(([name, service]) => [name, plainView(service, bridge, name)]));
        const run = () => setup(view as PlainServices<Requires>, plugin as PlainSetup<ConfigOf<C>>);
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
  owner: Context.Service.Shape<typeof PluginContext> & { readonly config: unknown; readonly signal: AbortSignal },
  bridge: Bridge,
  hooks: Context.Service.Shape<typeof Hooks>,
  events: Context.Service.Shape<typeof Events>,
  registries: Context.Service.Shape<typeof Registries>,
  cleanups: (() => void | PromiseLike<void>)[],
  base: Context.Context<never>,
): PlainSetup<unknown> => {
  const causeOf = (error: unknown) => (isExpectedFailure(error) ? Cause.fail(error) : Cause.die(error));
  // A call refused as a plugin stopped (its own, or another's it was waiting on) is how stopping ends work: no fault.
  const report = (operation: string, error: unknown) => {
    if (!(error instanceof PluginStopped)) runFork(owner.fault(operation, causeOf(error)));
  };
  /** Stopping or stopped: its signal aborts before its cleanups run, and what starts now would outlive it. */
  const gone = () => bridge.stopped() || owner.signal.aborted;
  // Run as the plugin's own work, whatever invocation is current where the handler fires (another plugin's emit).
  const action: PlainSetup<unknown>["action"] =
    (name, fn) =>
    (...args) => {
      if (gone()) return;
      try {
        const result = within({ context: base, invocation: undefined }, () => fn(...args));
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function")
          (result as PromiseLike<unknown>).then(undefined, (error) => report(name, error));
      } catch (error) {
        report(name, error);
      }
    };
  /** Background work the returned function cancels: it completes quietly, as the plugin stopping interrupts it. */
  const cancellable = (name: string, work: Effect.Effect<unknown, unknown>) => {
    if (gone()) return () => {};
    const cancel = Deferred.makeUnsafe<void>();
    void bridge.run(owner.background(name, Effect.raceFirst(work, Deferred.await(cancel))), `background ${name}`, BELONGS_TO_PLUGIN).catch(() => undefined);
    return () => void runSync(Deferred.succeed(cancel, undefined));
  };
  const called = (fn: (signal: AbortSignal) => Awaitable<unknown, unknown>): Effect.Effect<unknown, unknown> =>
    inContext((invocation) => fn(invocation.signal())) as Effect.Effect<unknown, unknown>;
  return {
    id: owner.id,
    ...(owner.version === undefined ? {} : { version: owner.version }),
    config: owner.config,
    signal: owner.signal,
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
      void bridge.run(register, `on ${hook.name}`, BELONGS_TO_PLUGIN);
    },
    add: (registry, item, options) => {
      const added = bridge.run(owner.add(registry, item, options), `add ${registry.name}`, BELONGS_TO_PLUGIN);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        void added.then(
          (remove) => (bridge.stopped() ? undefined : bridge.run(remove, `remove ${registry.name}`, BELONGS_TO_PLUGIN)),
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
      void bridge.run(register, `observe ${event.name}`, BELONGS_TO_PLUGIN);
    },
    // A stopped plugin's news is dropped: publishing never fails.
    publish: (event, payload) => void (bridge.stopped() ? undefined : runFork(events.publish(event, payload))),
    invoke: (hook, input, terminal, options) => {
      const wantsSignal = terminal.length >= 2;
      return bridge.run(
        hooks.invoke(
          hook,
          input,
          (value) => inContext((invocation) => terminal(value, (wantsSignal ? invocation.signal() : undefined) as AbortSignal)),
          options,
        ),
        `invoke ${hook.name}`,
      );
    },
    items: (registry) => {
      if (bridge.stopped()) throw new PluginStopped({ pluginId: owner.id, operation: `items ${registry.name}` });
      return runSync(registries.items(registry));
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
        BELONGS_TO_PLUGIN,
      ),
    fault: (operation, error, options) => void runFork(owner.fault(operation, causeOf(error), options)),
    run: (effect) => bridge.run(effect, "run"),
    trace: <A>(name: string, fn: (signal: AbortSignal) => Awaitable<A, unknown>) =>
      bridge.run(owner.trace(name, called(fn) as Effect.Effect<A, unknown>), `trace ${name}`),
    after: (ms, fn, options) => cancellable(options?.name ?? `after ${ms}ms`, Effect.andThen(Effect.sleep(Duration.millis(ms)), called(fn))),
    every: (ms, fn, options) => {
      const name = options?.name ?? `every ${ms}ms`;
      // A failed run is reported, and the timer goes on.
      const run = Effect.catchCause(called(fn), (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : owner.fault(name, cause)));
      return cancellable(name, Effect.forever(Effect.andThen(Effect.sleep(Duration.millis(ms)), run)));
    },
    listen: (target, type, listener, options) => {
      // Nothing would remove it: its cleanups have run, or are running.
      if (gone()) return () => {};
      // `once` for an emitter too, which has no such option.
      const handler = action(`listen ${type}`, options?.once === true ? (event: any) => (remove(), listener(event)) : listener);
      const detach =
        "addEventListener" in target
          ? (target.addEventListener(type, handler, options), () => target.removeEventListener(type, handler, options))
          : (target.on(type, handler), () => target.off(type, handler));
      let attached = true;
      const remove = () => {
        if (!attached) return;
        attached = false;
        detach();
        // Removed by hand, it leaves the cleanups: a view that listens each time it opens adds none for good.
        const at = cleanups.indexOf(remove);
        if (at !== -1) cleanups.splice(at, 1);
      };
      cleanups.push(remove);
      return remove;
    },
    task: (name, fn) =>
      new Promise((resolve) => {
        if (bridge.stopped()) return resolve(undefined);
        // Asked as it stops (a cleanup's flush, say): its scope is closing, so it runs as a call of the cleanup's, now.
        if (owner.signal.aborted) return void bridge.run(called(fn), `task ${name}`).then(resolve as (value: unknown) => void, () => resolve(undefined));
        const work = called(fn).pipe(
          Effect.tap((value) => Effect.sync(() => resolve(value as never))),
          Effect.onExit((exit) => Effect.sync(() => (exit._tag === "Failure" ? resolve(undefined) : undefined))),
        );
        void bridge.run(owner.background(name, work), `task ${name}`, BELONGS_TO_PLUGIN).catch(() => resolve(undefined));
      }),
    action,
  };
};
