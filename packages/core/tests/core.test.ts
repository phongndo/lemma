import { describe, expect, test } from "vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, References, Result, Schema, Scope } from "effect";
import {
  CapabilityMismatch,
  CompositionError,
  CoreClosed,
  definePlugin,
  Event,
  Events,
  Hook,
  Hooks,
  makeCore,
  PluginContext,
  PluginFault,
  Registries,
  Registry,
} from "../src/index.ts";
import type { Core, Plugin } from "../src/index.ts";
import { failure, run, waitFor } from "./support.ts";

class Prefix extends Context.Service<Prefix, string>()("test/Prefix") {}
class Format extends Context.Service<Format, (text: string) => string>()("test/Format") {}

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
        expect(yield* core.inspect).toEqual({ state: "active", faultSequence: 0, provided: [], plugins: [], hooks: [], events: [], registries: [] });
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
    class Request extends Context.Service<Request, string>()("test/Request") {}
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

  test("activation sees the caller's runtime settings, not its services, Effect's own included", async () => {
    class Ambient extends Context.Service<Ambient, string>()("test/Ambient") {}
    let seen: { readonly ambient: Option.Option<string>; readonly files: boolean; readonly level: string } | undefined;
    const probe = definePlugin({
      id: "probe",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          seen = {
            ambient: yield* Effect.serviceOption(Ambient),
            files: Option.isSome(yield* Effect.serviceOption(FileSystem.FileSystem)),
            level: yield* References.MinimumLogLevel,
          };
        }),
      ),
    });
    await run(
      makeCore([probe]).pipe(
        Effect.provideService(Ambient, "host"),
        Effect.provideService(FileSystem.FileSystem, {} as FileSystem.FileSystem),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );
    expect(seen).toEqual({ ambient: Option.none(), files: false, level: "Debug" });
  });

  test("a hook handler runs with its invoker's runtime settings, not those it was registered under", async () => {
    const point = Hook.make<number, string>("test/settings");
    const handler = definePlugin({
      id: "handler",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(point, () => References.MinimumLogLevel))),
    });
    const level = await run(
      Effect.gen(function* () {
        const core = yield* makeCore([handler]).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"));
        return yield* core
          .run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(point, 1, () => Effect.succeed("terminal"))))
          .pipe(Effect.provideService(References.MinimumLogLevel, "Error"));
      }),
    );
    expect(level).toBe("Error");
  });

  test("validates actual exports and cleans up malformed Layers", async () => {
    for (const extra of [false, true]) {
      let released = false;
      const layer = Layer.effectContext(
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
        const mismatch = Option.getOrThrow(Cause.findErrorOption(error.cause));
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
      layer: Layer.effect(
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
      layer: Layer.effectDiscard(
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
      layer: Layer.effect(
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
      layer: Layer.effectDiscard(
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
        if (error instanceof PluginFault) expect(Option.getOrThrow(Cause.findErrorOption(error.cause))).toEqual(boom);
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
    if (error instanceof PluginFault) expect(Result.getOrThrow(Cause.findDefect(error.cause))).toMatchObject({ message: defect.message, stack: defect.stack });
  });

  test("interrupted activation unwinds resources without converting cancellation to failure", async () => {
    let released = false;
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const plugin = definePlugin({
          id: "waiting",
          layer: Layer.effectDiscard(
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
        const fiber = yield* Effect.forkChild(makeCore([plugin]));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
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
          layer: Layer.effect(
            Prefix,
            Effect.acquireRelease(Effect.succeed("x"), () =>
              Effect.sync(() => {
                events.push("resource-");
              }),
            ),
          ),
        });
        const core = yield* Scope.provide(makeCore([plugin]), scope);
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
        const fiber = yield* Effect.forkChild(core.run(task));
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        expect(events).toEqual(["work-", "resource-"]);
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
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
        const fiber = yield* Effect.forkChild(
          core.run(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
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
          layer: Layer.effectDiscard(
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
        const fiber = yield* Effect.forkChild(Scope.provide(makeCore([waiting]), scope));
        yield* Deferred.await(entered);
        yield* Scope.close(scope, Exit.void);
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
        expect(released).toBe(true);
        const late = yield* Effect.exit(Scope.provide(makeCore([]), scope));
        expect(Exit.isFailure(late) && Cause.hasInterruptsOnly(late.cause)).toBe(true);
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
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              yield* Effect.forkScoped(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
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
      layer: Layer.effect(
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
      layer: Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleaned.push("b");
          }).pipe(Effect.andThen(Effect.die("cleanup"))),
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
      layer: Layer.effectDiscard(
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

describe("capabilities the application provides", () => {
  class Clock extends Context.Service<Clock, { readonly now: () => number }>()("test/Clock") {}
  const clock = { now: () => 7 };
  const stamper = definePlugin({
    id: "stamper",
    requires: [Clock],
    provides: [Prefix],
    layer: Layer.effect(
      Prefix,
      Effect.map(Clock, (service) => `${service.now()} `),
    ),
  });

  test("plugins require them as any other capability, and work run in the core gets them", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([formatter, stamper], { provide: { provides: [Clock], layer: Layer.succeed(Clock, clock) } });
        expect(yield* core.run(Clock)).toBe(clock);
        expect(yield* core.run(Effect.map(Format, (format) => format("o'clock")))).toBe("7 o'clock");
        const snapshot = yield* core.inspect;
        expect(snapshot.provided).toEqual([Clock.key]);
        // The application has no plugin row; a plugin's requires still names what it uses.
        expect(snapshot.plugins.map((plugin) => [plugin.id, plugin.requires])).toEqual([
          ["stamper", [Clock.key]],
          ["formatter", [Prefix.key]],
        ]);
      }),
    );
  });

  test("no plugin may provide one, and the application may not provide the runtime's own", async () => {
    let starts = 0;
    let built = 0;
    let released = 0;
    const marker = definePlugin({ id: "marker", layer: Layer.effectDiscard(Effect.sync(() => starts++)) });
    const rival = definePlugin({ id: "rival", provides: [Clock], layer: Layer.succeed(Clock, clock) });
    const counted = Layer.effect(
      Clock,
      Effect.acquireRelease(
        Effect.sync(() => {
          built++;
          return clock;
        }),
        () => Effect.sync(() => void released++),
      ),
    );
    const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([marker, rival], { provide: { provides: [Clock], layer: counted } }))));
    expect(error).toMatchObject({ _tag: "CompositionError", reason: "ReservedCapability", plugins: ["rival"], capability: Clock.key });
    expect(error.message).toContain("the application provides it");
    expect([starts, built, released]).toEqual([0, 1, 1]);

    // Refused before anything is built: merged over the built-ins, it would replace the core's own.
    const hooks = Layer.sync(Hooks, () => {
      built++;
      return { invoke: (_hook, value, end) => end(value) };
    });
    const refused = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([marker], { provide: { provides: [Hooks], layer: hooks } }))));
    expect(refused).toMatchObject({ _tag: "CompositionError", reason: "ReservedCapability", plugins: [], capability: Hooks.key });
    expect([starts, built]).toEqual([0, 1]);
  });

  test("their layer uses the core's hooks, events, and registries, and nothing of the caller's", async () => {
    class Ambient extends Context.Service<Ambient, string>()("test/Ambient") {}
    const Ask = Hook.make<string, string>("test/ask");
    const Saved = Event.make<string>("test/saved");
    const Menu = Registry.make<string>("test/menu");
    class Desk extends Context.Service<
      Desk,
      {
        readonly ask: (question: string) => Effect.Effect<string, unknown>;
        readonly save: (text: string) => Effect.Effect<void>;
        readonly menu: Effect.Effect<readonly string[]>;
        readonly ambient: Option.Option<string>;
      }
    >()("test/Desk") {}
    const desk = Layer.effect(
      Desk,
      Effect.gen(function* () {
        const hooks = yield* Hooks;
        const events = yield* Events;
        const registries = yield* Registries;
        return {
          ask: (question: string) => hooks.invoke(Ask, question, () => Effect.succeed("unanswered")),
          save: (text: string) => events.publish(Saved, text),
          menu: Effect.map(registries.items(Menu), (items) => items.map((entry) => entry.item)),
          ambient: yield* Effect.serviceOption(Ambient),
        };
      }),
    );
    const saved: string[] = [];
    const helper = definePlugin({
      id: "helper",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(Ask, (question) => Effect.succeed(`answered ${question}`));
          yield* owner.observe(Saved, (text) => Effect.sync(() => void saved.push(text)));
          yield* owner.add(Menu, "Open");
        }),
      ),
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([helper], { provide: { provides: [Desk], layer: desk } }).pipe(Effect.provideService(Ambient, "caller"));
        const service = yield* core.run(Desk);
        expect(service.ambient).toEqual(Option.none());
        expect(yield* service.ask("why")).toBe("answered why");
        expect(yield* service.menu).toEqual(["Open"]);
        yield* service.save("draft");
        expect(
          yield* waitFor(
            Effect.sync(() => saved),
            (texts) => texts.length > 0,
          ),
        ).toEqual(["draft"]);
      }),
    );
  });

  test("they are built before the first plugin activates and released after the last is disposed", async () => {
    const log: string[] = [];
    const logged = Layer.effect(
      Clock,
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push("application+");
          return clock;
        }),
        () => Effect.sync(() => void log.push("application-")),
      ),
    );
    const user = (id: string) =>
      definePlugin({
        id,
        requires: [Clock],
        layer: Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.sync(() => void log.push(`${id}+`)),
            () => Effect.sync(() => void log.push(`${id}-`)),
          ),
        ),
      });
    await run(makeCore([user("a"), user("b")], { provide: { provides: [Clock], layer: logged } }));
    expect(log).toEqual(["application+", "a+", "b+", "b-", "a-", "application-"]);
  });

  test("a build failure fails makeCore with its error, activating nothing and leaving nothing behind", async () => {
    let starts = 0;
    const log: string[] = [];
    const marker = definePlugin({ id: "marker", requires: [Clock], layer: Layer.effectDiscard(Effect.sync(() => starts++)) });
    const failing = Layer.effect(
      Clock,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("released")));
        return yield* Effect.fail({ reason: "no clock" } as const);
      }),
    );
    await run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(makeCore([marker], { provide: { provides: [Clock], layer: failing } }));
        const error: { readonly reason: "no clock" } | CompositionError | PluginFault = failure(exit);
        expect(error).toEqual({ reason: "no clock" });
        // Still inside the caller's scope, and what the build acquired is already released.
        expect(log).toEqual(["released"]);
      }),
    );
    expect(starts).toBe(0);
    expect(log).toEqual(["released"]);
  });

  test("an interrupted build releases what it acquired, without converting cancellation to failure", async () => {
    let released = false;
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const waiting = Layer.effect(
          Clock,
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => void (released = true)));
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        );
        const fiber = yield* Effect.forkChild(makeCore([], { provide: { provides: [Clock], layer: waiting } }));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(released).toBe(true);
      }),
    );
  });

  test("services that differ from what the application declares are a defect naming the difference", async () => {
    const released: string[] = [];
    const wrong = Layer.effectContext(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void released.push("wrong")));
        return Context.make(Prefix, "undeclared");
      }),
    );
    const exit = await Effect.runPromiseExit(Effect.scoped(makeCore([], { provide: { provides: [Clock], layer: wrong as unknown as Layer.Layer<Clock> } })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.none());
      expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toMatchObject({
        message: expect.stringContaining(`missing: ${Clock.key}; undeclared: ${Prefix.key}`),
      });
    }
    expect(released).toEqual(["wrong"]);
  });
});
