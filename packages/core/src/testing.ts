import { Effect, Exit, Layer, Scope, Stream } from "effect";
import type { Context } from "effect";
import type { CoreSnapshot } from "./core.ts";
import { makeCore } from "./core.ts";
import type { ReportedFault } from "./errors.ts";
import { definePlugin } from "./plugin.ts";
import type { Capability, Plugin } from "./plugin.ts";

export interface TestPluginOptions {
  /** The config of the plugin under test, as a config file would hold it (decoded by its Schema). */
  readonly config?: unknown;
  /** Other plugins it runs with: real providers of what it requires, or plugins that use what it provides. */
  readonly with?: readonly Plugin[];
  /** Configs of the plugins in `with`, by id. */
  readonly configs?: Readonly<Record<string, unknown>>;
  /** Stand-ins for capabilities it requires, each provided by a plugin of its own: `[[Store, fakeStore]]`. */
  readonly provide?: ReadonlyArray<readonly [Capability, unknown]>;
}

/** A plugin running in a composition of its own, driven from a test. */
export interface TestedPlugin extends AsyncDisposable {
  /** A capability's service as the composition provides it. */
  readonly get: <T extends Capability>(tag: T) => Promise<Context.Service.Shape<T>>;
  /** Runs an Effect with the composition's capabilities, as `core.run` does. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;
  /**
   * Faults reported, in order; it grows as they come. Of those reported while it started (a background task failing
   * at once), each plugin's latest; a fault that fails activation fails `testPlugin` instead.
   */
  readonly faults: readonly ReportedFault[];
  /** Resolves with the first fault, reported or yet to be, that matches; rejects after `timeoutMs` (default 5000). */
  readonly waitForFault: (predicate: (fault: ReportedFault) => boolean, timeoutMs?: number) => Promise<ReportedFault>;
  readonly inspect: () => Promise<CoreSnapshot>;
  /** Stops every plugin, in reverse order, and waits for their cleanup. */
  readonly close: () => Promise<void>;
}

/**
 * Starts `plugin` the way an application would, with `provide` standing in
 * for what it requires, and returns promise-based handles for a test. Fails
 * as `makeCore` does: a `CompositionError` when it cannot plan (a missing
 * capability, an invalid config), a `PluginFault` when activation fails.
 *
 *   const tested = await testPlugin(approvals, { provide: [[Store, fakeStore]] });
 *   expect(await tested.run(Effect.flatMap(Store, (store) => store.get("a")))).toBe(…);
 *   await tested.close();
 */
export async function testPlugin(plugin: Plugin, options: TestPluginOptions = {}): Promise<TestedPlugin> {
  const fakes = (options.provide ?? []).map(([tag, service]) =>
    definePlugin({ id: `test-double ${tag.key}`, provides: [tag], layer: Layer.succeed(tag, service) as never }),
  );
  const scope = Scope.makeUnsafe();
  const faults: ReportedFault[] = [];
  const waiting = new Set<() => void>();
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const core = await Effect.runPromise(
      makeCore([...fakes, ...(options.with ?? []), plugin], {
        configs: { ...options.configs, ...(options.config === undefined ? {} : { [plugin.id]: options.config }) },
      }).pipe(Scope.provide(scope)),
    );
    const heard = (fault: ReportedFault) => {
      if (faults.some((known) => known.sequence === fault.sequence)) return;
      faults.push(fault);
      faults.sort((a, b) => a.sequence - b.sequence);
      // A waiter removes itself when it wakes; a set may lose entries already visited while it is iterated.
      for (const wake of waiting) wake();
    };
    await Effect.runPromise(
      Effect.forkIn(
        Stream.runForEach(core.faults, (fault) => Effect.sync(() => heard(fault))),
        scope,
        { startImmediately: true },
      ),
    );
    // Faults reported while it started had no listener yet: each plugin's latest is in the snapshot.
    for (const snapshot of (await Effect.runPromise(core.inspect)).plugins) {
      const fault = snapshot.fault as ReportedFault | undefined;
      if (fault?.sequence !== undefined) heard(fault);
    }
    const waitForFault = (predicate: (fault: ReportedFault) => boolean, timeoutMs = 5000) =>
      new Promise<ReportedFault>((resolve, reject) => {
        const check = () => {
          const found = faults.find(predicate);
          if (found === undefined) return false;
          waiting.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          waiting.delete(check);
          reject(new Error(`No matching fault within ${timeoutMs} ms; faults: ${faults.map((fault) => fault.message).join("; ") || "none"}`));
        }, timeoutMs);
        if (!check()) waiting.add(check);
      });
    const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(core.run(effect) as Effect.Effect<A, unknown, never>);
    return {
      get: (tag) => run(tag as unknown as Effect.Effect<never>),
      run,
      faults,
      waitForFault,
      inspect: () => Effect.runPromise(core.inspect),
      close,
      [Symbol.asyncDispose]: close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
