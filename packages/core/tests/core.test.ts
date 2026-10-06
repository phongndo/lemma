import { describe, expect, test } from "vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect";
import { PluginFault, CapabilityMismatch, CompositionError, CoreClosed, definePlugin, Hook, Hooks, makeCore, PluginContext } from "../src/index.ts";
import type { Core, Plugin } from "../src/index.ts";
import { failure, run } from "./support.ts";

class Prefix extends Context.Tag("test/Prefix")<Prefix, string>() {}
class Format extends Context.Tag("test/Format")<Format, (text: string) => string>() {}

const prefix = (text = "hello ") =>
  definePlugin({
    id: "prefix",
    version: "1.0.0",
    provides: [Prefix],
    layer: Layer.succeed(Prefix, text),
  });
const formatter = definePlugin({
  id: "formatter",
  requires: [Prefix],
  provides: [Format],
  layer: Layer.effect(
    Format,
    Effect.map(Prefix, (value) => (text: string) => value + text),
  ),
});

describe("composition", () => {
  test("an empty core has no application behavior and rejects use after scope closure", async () => {
    let core!: Core;
    await run(
      Effect.gen(function* () {
        core = yield* makeCore([]);
        expect(yield* core.run(Effect.succeed(42))).toBe(42);
        expect(yield* core.inspect).toEqual({ state: "active", faultSequence: 0, plugins: [], hooks: [], events: [], registries: [] });
      }),
    );
    expect((await Effect.runPromise(core.inspect)).state).toBe("closed");
    expect(failure(await Effect.runPromiseExit(core.run(Effect.void)))).toBeInstanceOf(CoreClosed);
  });

  test("resolves dependencies, supports alternative providers, and isolates separate compositions", async () => {
    await run(
      Effect.gen(function* () {
        const a = yield* makeCore([formatter, prefix()]);
        const b = yield* makeCore([prefix("goodbye "), formatter]);
        expect(yield* a.run(Effect.map(Format, (format) => format("world")))).toBe("hello world");
        expect(yield* b.run(Effect.map(Format, (format) => format("world")))).toBe("goodbye world");
        const snapshot = yield* a.inspect;
        expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["prefix", "formatter"]);
        expect(snapshot.plugins[0]?.version).toBe("1.0.0");
        expect(snapshot.plugins[1]?.requires).toEqual([Prefix.key]);
        // Inspection returns detached data, never the mutable registry.
        (snapshot.plugins as unknown as unknown[]).length = 0;
        expect((yield* a.inspect).plugins.length).toBe(2);
      }),
    );
  });

  test("decodes config before activation and rejects the whole composition on invalid config", async () => {
    let activated = false;
    const Settings = Schema.Struct({ text: Schema.String });
    const configured = definePlugin({
      id: "configured",
      config: Settings,
      provides: [Prefix],
      layer: (config) =>
        Layer.effect(
          Prefix,
          Effect.sync(() => {
            activated = true;
            return config.text;
          }),
        ),
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([configured], { configs: { configured: { text: "configured " } } });
        expect(yield* core.run(Prefix)).toBe("configured ");
      }),
    );
    activated = false;
    const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([configured, formatter], { configs: { configured: { text: 1 } } }))));
    expect(error).toMatchObject({ reason: "InvalidConfig", plugins: ["configured"] });
    expect(error.message).toContain("text");
    expect(activated).toBe(false);
    // A schema-less plugin ignores config; a schema plugin needs it.
    expect(failure(await Effect.runPromiseExit(Effect.scoped(makeCore([configured]))))).toMatchObject({ reason: "InvalidConfig" });
  });

  test("preserves caller requirements not supplied by the core", async () => {
    class Request extends Context.Tag("test/Request")<Request, string>() {}
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([prefix()]);
        const request = core.run(
          Effect.gen(function* () {
            return (yield* Prefix) + (yield* Request);
          }),
        );
        expect(yield* Effect.provideService(request, Request, "caller")).toBe("hello caller");
      }),
    );
  });

  test("rejects invalid graphs before running any Layer", async () => {
    let starts = 0;
    const marker = definePlugin({ id: "marker", layer: Layer.effectDiscard(Effect.sync(() => starts++)) });
    const cases: [readonly Plugin[], CompositionError["reason"]][] = [
      [[marker, marker], "DuplicatePlugin"],
      [[marker, prefix(), definePlugin({ id: "other", provides: [Prefix], layer: Layer.succeed(Prefix, "x") })], "DuplicateCapability"],
      [[marker, formatter], "MissingCapability"],
      [[marker, definePlugin({ id: " ", layer: Layer.empty })], "InvalidId"],
      [
        [marker, definePlugin({ id: "reserved", provides: [Hooks], layer: Layer.succeed(Hooks, { invoke: (_hook, value, end) => end(value) }) })],
        "ReservedCapability",
      ],
    ];
    for (const [plugins, reason] of cases) {
      const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore(plugins))));
      expect(error).toBeInstanceOf(CompositionError);
      if (error instanceof CompositionError) expect(error.reason).toBe(reason);
    }
    expect(starts).toBe(0);
  });

  test("reports the dependency cycle, including self-dependencies", async () => {
    const a = definePlugin({ id: "a", requires: [Format], provides: [Prefix], layer: Layer.succeed(Prefix, "x") });
    const b = definePlugin({ id: "b", requires: [Prefix], provides: [Format], layer: Layer.succeed(Format, (x: string) => x) });
    const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([b, a]))));
    expect(error).toMatchObject({ reason: "DependencyCycle", plugins: ["a", "b", "a"] });
    const self = definePlugin({ id: "self", requires: [Prefix], provides: [Prefix], layer: Layer.succeed(Prefix, "x") });
    expect(failure(await Effect.runPromiseExit(Effect.scoped(makeCore([self]))))).toMatchObject({
      reason: "DependencyCycle",
      plugins: ["self", "self"],
    });
  });

  test("does not expose undeclared dependencies to a dynamically supplied plugin", async () => {
    // Models an untyped plugin crossing the package seam.
    const invalid: Plugin = { id: "z-invalid", provides: [], requires: [], exclusive: false, layer: () => Layer.effectDiscard(Prefix) };
    const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([prefix(), invalid])).pipe(Effect.provideService(Prefix, "ambient"))));
    expect(error).toBeInstanceOf(PluginFault);
    if (error instanceof PluginFault) expect(Cause.pretty(error.cause)).toContain(Prefix.key);
  });

  test("validates actual exports and cleans up malformed Layers", async () => {
    for (const extra of [false, true]) {
      let released = false;
      const layer = Layer.scopedContext(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
          return extra ? Context.make(Prefix, "undeclared") : Context.empty();
        }),
      );
      const invalid: Plugin = { id: "invalid", requires: [], provides: extra ? [] : [Prefix], exclusive: false, layer: () => layer };
      const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([invalid]))));
      expect(error).toBeInstanceOf(PluginFault);
      if (error instanceof PluginFault) {
        const mismatch = Option.getOrThrow(Cause.failureOption(error.cause));
        expect(mismatch).toBeInstanceOf(CapabilityMismatch);
        expect(mismatch).toMatchObject(extra ? { undeclared: [Prefix.key] } : { missing: [Prefix.key] });
      }
      expect(released).toBe(true);
    }
  });
});

describe("lifetimes", () => {
  test("acquires once and disposes dependents before providers", async () => {
    const events: string[] = [];
    const base = definePlugin({
      id: "base",
      provides: [Prefix],
      layer: Layer.scoped(
        Prefix,
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("base+");
            return "prefix";
          }),
          () =>
            Effect.sync(() => {
              events.push("base-");
            }),
        ),
      ),
    });
    const consumer = definePlugin({
      id: "consumer",
      requires: [Prefix],
      layer: Layer.scopedDiscard(
        Effect.acquireRelease(
          Effect.map(Prefix, () => {
            events.push("consumer+");
          }),
          () =>
            Effect.sync(() => {
              events.push("consumer-");
            }),
        ),
      ),
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([consumer, base]);
        yield* core.run(Prefix);
        yield* core.run(Prefix);
        expect(events).toEqual(["base+", "consumer+"]);
      }),
    );
    expect(events).toEqual(["base+", "consumer+", "consumer-", "base-"]);
  });

  test("failure rolls back immediately, retaining the original cause", async () => {
    const events: string[] = [];
    const boom = { reason: "boom" };
    const base = definePlugin({
      id: "base",
      provides: [Prefix],
      layer: Layer.scoped(
        Prefix,
        Effect.acquireRelease(Effect.succeed("x"), () =>
          Effect.sync(() => {
            events.push("base-");
          }),
        ),
      ),
    });
    const broken = definePlugin({
      id: "broken",
      requires: [Prefix],
      layer: Layer.scopedDiscard(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push("broken-");
            }),
          );
          return yield* Effect.fail(boom);
        }),
      ),
    });
    await run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(makeCore([broken, base]));
        const error = failure(exit);
        expect(error).toBeInstanceOf(PluginFault);
        if (error instanceof PluginFault) expect(Option.getOrThrow(Cause.failureOption(error.cause))).toEqual(boom);
        // We are still inside the caller's scope, but all failed activation resources are gone.
        expect(events).toEqual(["broken-", "base-"]);
      }),
    );
    expect(events).toEqual(["broken-", "base-"]);
  });

  test("activation defects retain their cause", async () => {
    const defect = new Error("unexpected");
    const plugin = definePlugin({ id: "broken", layer: Layer.effectDiscard(Effect.die(defect)) });
    const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([plugin]))));
    expect(error).toBeInstanceOf(PluginFault);
    if (error instanceof PluginFault) expect(Option.getOrThrow(Cause.dieOption(error.cause))).toMatchObject({ message: defect.message, stack: defect.stack });
  });

  test("interrupted activation unwinds resources without converting cancellation to failure", async () => {
    let released = false;
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const plugin = definePlugin({
          id: "waiting",
          layer: Layer.scopedDiscard(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true;
                }),
              );
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.never;
            }),
          ),
        });
        const fiber = yield* Effect.fork(makeCore([plugin]));
        yield* Deferred.await(entered);
        const result = yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause)).toBe(true);
        expect(released).toBe(true);
      }),
    );
  });

  test("scope closure interrupts active work before releasing plugin resources", async () => {
    const events: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const plugin = definePlugin({
          id: "resource",
          provides: [Prefix],
          layer: Layer.scoped(
            Prefix,
            Effect.acquireRelease(Effect.succeed("x"), () =>
              Effect.sync(() => {
                events.push("resource-");
              }),
            ),
          ),
        });
        const core = yield* Scope.extend(makeCore([plugin]), scope);
        const task = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              events.push("work-");
            }),
          ),
        );
        const fiber = yield* Effect.fork(core.run(task));
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        expect(events).toEqual(["work-", "resource-"]);
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause)).toBe(true);
        expect((yield* core.inspect).state).toBe("closed");
      }),
    );
  });

  test("caller cancellation does not leave core.run work detached", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([]);
        const entered = yield* Deferred.make<void>();
        let cleaned = false;
        const fiber = yield* Effect.fork(
          core.run(
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true;
                }),
              ),
            ),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(cleaned).toBe(true);
        expect(yield* core.run(Effect.succeed("still active"))).toBe("still active");
      }),
    );
  });

  test("closing the caller scope interrupts activation and cannot publish a dead core", async () => {
    let released = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const entered = yield* Deferred.make<void>();
        const waiting = definePlugin({
          id: "waiting",
          layer: Layer.scopedDiscard(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true;
                }),
              );
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.never;
            }),
          ),
        });
        const fiber = yield* Effect.fork(Scope.extend(makeCore([waiting]), scope));
        yield* Deferred.await(entered);
        yield* Scope.close(scope, Exit.void);
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause)).toBe(true);
        expect(released).toBe(true);
        const late = yield* Effect.exit(Scope.extend(makeCore([]), scope));
        expect(Exit.isFailure(late) && Cause.isInterruptedOnly(late.cause)).toBe(true);
      }),
    );
  });

  test("Layer-owned background fibers are interrupted and awaited on disposal", async () => {
    let cleaned = false;
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const worker = definePlugin({
          id: "worker",
          layer: Layer.scopedDiscard(
            Effect.gen(function* () {
              yield* Effect.forkScoped(
                Deferred.succeed(started, undefined).pipe(
                  Effect.zipRight(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      cleaned = true;
                    }),
                  ),
                ),
              );
              yield* Deferred.await(started);
            }),
          ),
        });
        yield* makeCore([worker]);
        expect(cleaned).toBe(false);
      }),
    );
    expect(cleaned).toBe(true);
  });

  test("cleanup defects remain visible without preventing remaining cleanup", async () => {
    const cleaned: string[] = [];
    const a = definePlugin({
      id: "a",
      provides: [Prefix],
      layer: Layer.scoped(
        Prefix,
        Effect.acquireRelease(Effect.succeed("x"), () =>
          Effect.sync(() => {
            cleaned.push("a");
          }),
        ),
      ),
    });
    const b = definePlugin({
      id: "b",
      requires: [Prefix],
      layer: Layer.scopedDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleaned.push("b");
          }).pipe(Effect.zipRight(Effect.die("cleanup"))),
        ),
      ),
    });
    const result = await Effect.runPromiseExit(Effect.scoped(makeCore([b, a])));
    expect(cleaned).toEqual(["b", "a"]);
    expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("cleanup");
  });

  test("repeated mounting leaves no active resources or handlers", async () => {
    let resources = 0;
    const point = Hook.make<string, string>("echo");
    const plugin = definePlugin({
      id: "echo",
      layer: Layer.scopedDiscard(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              resources++;
            }),
            () =>
              Effect.sync(() => {
                resources--;
              }),
          );
          const owner = yield* PluginContext;
          yield* owner.on(point, (input, next) => next(input));
        }),
      ),
    });
    for (let i = 0; i < 40; i++) {
      let core!: Core;
      await run(
        Effect.gen(function* () {
          core = yield* makeCore([plugin]);
          expect(resources).toBe(1);
          expect((yield* core.inspect).hooks[0]?.handlers.length).toBe(1);
        }),
      );
      expect(resources).toBe(0);
      expect((await Effect.runPromise(core.inspect)).hooks).toEqual([]);
    }
  });
});
