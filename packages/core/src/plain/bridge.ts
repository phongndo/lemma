import { Cause, Context, Effect, Exit, Option, Scope, Stream } from "effect";
import { fail } from "../awaitable.ts";
import type { Invocation } from "../awaitable.ts";
import { PluginStopped } from "../errors.ts";
import { current } from "../internal/current.ts";
import type { SetupCalls } from "../internal/current.ts";

/**
 * A promise that knows whether anything awaited or chained it: one nothing
 * did is a call whose failure nobody would hear, which is reported as the
 * plugin's fault instead of failing the process as an unhandled rejection.
 * `await` reaches a subclass through `then`, so the flag sees it.
 */
class Watched<A> extends Promise<A> {
  static override get [Symbol.species]() {
    return Promise;
  }
  observed = false;
  // Overridden only to see who awaits or chains it; it is a promise either way.
  // oxlint-disable-next-line unicorn/no-thenable
  override then<T1 = A, T2 = never>(
    onFulfilled?: ((value: A) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    this.observed = true;
    return super.then(onFulfilled, onRejected);
  }
}

/** Attaches without marking the promise observed. */
const quietly = <A>(promise: Promise<A>, onRejected: (error: unknown) => void) => void Promise.prototype.then.call(promise, undefined, onRejected);

/** A service the plugin's calls always run with: its own, whoever's work led to the call. */
export interface Own {
  readonly key: Context.Key<unknown, unknown>;
  readonly value: unknown;
}

export interface BridgeOptions {
  readonly pluginId: string;
  /** The plugin's own context: what calls made outside any invocation (a timer, a socket's callback) run with. */
  readonly base: Context.Context<never>;
  /**
   * What makes a call the plugin's (its `PluginContext`, its `Scope`): set on
   * every call, so a callback another plugin runs still registers, reports,
   * and acquires as this one.
   */
  readonly own: readonly Own[];
  /** Aborted when the plugin stops. */
  readonly signal: AbortSignal;
  /** Reports a failure nobody awaited, as the plugin's fault. */
  readonly report: (operation: string, cause: Cause.Cause<unknown>) => void;
}

/** Promise-based code's way into Effects, for one plugin instance. */
export interface Bridge {
  readonly pluginId: string;
  /** Set once the plugin's own cleanup has run: calls are refused from then on. */
  readonly stopped: () => boolean;
  /**
   * Runs `effect` in the current invocation's context (else the plugin's),
   * as this plugin, stopped when that invocation is interrupted or the plugin
   * stops. Resolves with its value; rejects with its failure (marked, so
   * rethrowing it keeps it a failure), its defect, `PluginStopped` when the
   * plugin stopped it, or the invocation's abort reason.
   */
  readonly run: <A>(effect: Effect.Effect<A, unknown, any>, operation: string, how?: RunOptions) => Promise<A>;
  /**
   * A stream as an async iterable that ends when the invocation that started
   * it is interrupted or the plugin stops (what it had buffered then is not
   * read); its failure rejects as `run`'s do.
   */
  readonly iterate: <A>(stream: Stream.Stream<A, unknown, any>, operation: string) => AsyncIterable<A>;
  /** A call refused because the plugin stopped. */
  readonly refuse: (operation: string) => Promise<never>;
  /** A new record of the calls a setup makes (see `Current.setup`). */
  readonly startSetup: () => SetupCalls;
  /** Waits for the calls made during setup; rejects with the first that failed and that setup neither awaited nor caught. */
  readonly endSetup: (setup: SetupCalls) => Promise<void>;
  /**
   * The plugin's signal has aborted and its cleanups run: calls made now get
   * a lifetime and a scope of their own, so cleanup can still save through a
   * service, and what it acquires lasts until cleanup is done.
   */
  readonly beginCleanup: () => void;
  /**
   * Cleanup is done: what it left running stops, what it acquired is
   * released, and calls are refused from now on. Rejects if releasing fails.
   */
  readonly endCleanup: () => Promise<void>;
}

/** How `run` runs one call. */
export interface RunOptions {
  /**
   * `"plugin"`: in the plugin's own context and lifetime, whatever invocation
   * is current, for what belongs to the plugin rather than to the work that
   * made it (a handler it registers must not keep that work's references).
   */
  readonly context?: "current" | "plugin";
  /** False: without the plugin's own `PluginContext` and `Scope` (the rest of a hook's chain, which is the caller's). */
  readonly own?: boolean;
}

export const makeBridge = (options: BridgeOptions): Bridge => {
  let stopped = false;
  /** While cleanups run: the lifetime of the calls they make, and the scope what they acquire belongs to. */
  let cleanup: { readonly controller: AbortController; readonly scope: Scope.Closeable } | undefined;
  /** Failures `endSetup` reported as the activation's own; not reported again as unawaited. */
  const claimed = new WeakSet<Promise<unknown>>();

  /**
   * `context` as this plugin's: its own `PluginContext` and `Scope`, as
   * overlays where they differ. While cleanups run, the scope is cleanup's
   * own: the plugin's is closing, so what a cleanup acquires would be
   * released at once.
   */
  const owned = (context: Context.Context<never>): Context.Context<never> => {
    let result = context;
    for (const { key, value: own } of options.own) {
      const value = cleanup !== undefined && key.key === Scope.Scope.key ? cleanup.scope : own;
      if (Context.getOrUndefined(result, key) !== value) result = Context.addUnsafe(result, key.key, value) as Context.Context<never>;
    }
    return result;
  };

  interface Lifetime {
    readonly context: Context.Context<never>;
    readonly signal: AbortSignal;
    readonly setup: SetupCalls | undefined;
    readonly invocation: Invocation | undefined;
  }
  /** What a call lives within: the cleanup's lifetime while it runs, the plugin's otherwise, and the invocation's when there is one. */
  const lifetime = (how?: RunOptions): Lifetime => {
    const now = current();
    const plugin = cleanup?.controller.signal ?? options.signal;
    const setup = now?.setup?.open === true ? now.setup : undefined;
    if (how?.context === "plugin") return { context: owned(options.base), signal: plugin, setup, invocation: undefined };
    const invocation = now?.invocation;
    const its = invocation?.signal();
    const context = now?.context ?? options.base;
    return {
      context: how?.own === false ? context : owned(context),
      signal: its === undefined ? plugin : AbortSignal.any([plugin, its]),
      setup,
      invocation,
    };
  };

  /** A failure as promise-based code sees it: marked as expected, so rethrown in the same invocation it stays one. */
  const marked = (error: unknown, invocation: Invocation | undefined): unknown => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") return fail(error);
    invocation?.markFailure(error);
    return error;
  };

  const thrown = (cause: Cause.Cause<unknown>, signal: AbortSignal, operation: string, invocation: Invocation | undefined): unknown => {
    const failure = Cause.findErrorOption(cause);
    if (Option.isSome(failure)) return marked(failure.value, invocation);
    if (Cause.hasInterruptsOnly(cause)) {
      if (stopped || (cleanup === undefined && options.signal.aborted)) return new PluginStopped({ pluginId: options.pluginId, operation });
      return signal.aborted ? signal.reason : new Error(`${operation} was interrupted`);
    }
    return Cause.squash(cause);
  };

  /**
   * Every call's failure is handled the moment it exists, so none is an
   * unhandled rejection. One nobody awaited is reported as the plugin's fault
   * once the turn that could have awaited it is over, unless setup made it:
   * setup waits for its calls and fails the activation instead.
   */
  const watch = (promise: Watched<unknown>, operation: string, setup: SetupCalls | undefined, causeOf: (error: unknown) => Cause.Cause<unknown>) => {
    setup?.calls.push(promise);
    quietly(promise, (error) => {
      setTimeout(() => {
        // A call setup made is setup's to judge: its activation fails on one nobody heard.
        if (promise.observed || claimed.has(promise) || setup !== undefined) return;
        options.report(`unawaited ${operation}`, causeOf(error));
      }, 0);
    });
  };

  const refuse = (operation: string): Promise<never> => {
    const error = new PluginStopped({ pluginId: options.pluginId, operation });
    const refused = new Watched<never>((_, reject) => reject(error));
    // The plugin has stopped, so a fault of its would be dropped: a refusal nobody awaits is logged.
    quietly(refused, () => {
      setTimeout(() => {
        if (!refused.observed) Effect.runFork(Effect.logWarning(error.message));
      }, 0);
    });
    return refused;
  };

  return {
    pluginId: options.pluginId,
    stopped: () => stopped,
    run: <A>(effect: Effect.Effect<A, unknown, any>, operation: string, how?: RunOptions): Promise<A> => {
      if (stopped) return refuse(operation);
      const { context, signal, setup, invocation } = lifetime(how);
      // Made after its handler returned, it stops if the operation's fiber is interrupted; until it ends.
      const release = invocation?.follow();
      let failed: Cause.Cause<unknown> | undefined;
      const promise = new Watched<A>((resolve, reject) => {
        Effect.runPromiseExitWith(context)(effect as Effect.Effect<A, unknown, never>, { signal }).then((exit) => {
          release?.();
          if (Exit.isSuccess(exit)) return resolve(exit.value as A);
          failed = exit.cause;
          reject(thrown(exit.cause, signal, operation, invocation));
        });
      });
      watch(promise as Watched<unknown>, operation, setup, (error) => failed ?? Cause.die(error));
      return promise;
    },
    iterate: <A>(stream: Stream.Stream<A, unknown, any>, operation: string): AsyncIterable<A> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<A> => {
        if (stopped) return { next: () => refuse(operation) };
        const { context, signal, invocation } = lifetime();
        const release = invocation?.follow();
        // Ends the stream (done, not an error) when the signal aborts: one listener while it runs, removed when it ends.
        const aborted = Effect.callback<void>((resume) => {
          if (signal.aborted) return resume(Effect.void);
          const onAbort = () => resume(Effect.void);
          signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", onAbort));
        });
        const iterator = Stream.toAsyncIterableWith(
          (stream as Stream.Stream<A, unknown, never>).pipe(
            // Its failure is the stream's typed error, as a call's is: rethrown in the same invocation, it stays one.
            Stream.mapError((error) => marked(error, invocation)),
            Stream.interruptWhen(aborted),
            Stream.ensuring(Effect.sync(() => release?.())),
          ),
          context,
        )[Symbol.asyncIterator]();
        const done = async (): Promise<IteratorResult<A>> => {
          await iterator.return?.();
          return { done: true, value: undefined };
        };
        // What the stream had buffered when the signal aborted is not read: the iterable ends there.
        return { next: () => (signal.aborted ? done() : iterator.next()), return: done };
      },
    }),
    refuse,
    startSetup: () => ({ open: true, calls: [] }),
    endSetup: async (setup) => {
      // Waited for without marking them observed: a failure setup awaited or caught was its to handle; one it left
      // behind fails the activation. What setup made before it returned is waited for; a call made after (by a timer
      // or loop it started) is ordinary, so such work cannot hold the activation open.
      setup.open = false;
      const unheard: { readonly call: Promise<unknown>; readonly error: unknown }[] = [];
      await Promise.all(
        setup.calls.map(
          (call) =>
            new Promise<void>((resolve) =>
              Promise.prototype.then.call(
                call,
                () => resolve(),
                (error: unknown) => {
                  if (!(call as Watched<unknown>).observed) unheard.push({ call, error });
                  resolve();
                },
              ),
            ),
        ),
      );
      for (const { call } of unheard) claimed.add(call);
      if (unheard[0] !== undefined) throw unheard[0].error;
    },
    beginCleanup: () => {
      cleanup = { controller: new AbortController(), scope: Scope.makeUnsafe() };
    },
    endCleanup: async () => {
      stopped = true;
      if (cleanup === undefined) return;
      cleanup.controller.abort(new PluginStopped({ pluginId: options.pluginId, operation: "cleanup" }));
      const exit = await Effect.runPromiseExit(Scope.close(cleanup.scope, Exit.void));
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    },
  };
};
