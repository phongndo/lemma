import { describe, expect, test } from "vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Tracer } from "effect";
import { definePlugin, Hook, Hooks, makeCore, PluginContext } from "../src/index.ts";
import type { Handler, Next } from "../src/index.ts";
import { failure, run } from "./support.ts";

const point = Hook.make<number, number, string>("test/compute");
const middleware = (id: string, handler: Handler<number, number, string, PluginContext | Hooks>, order = 0) =>
  definePlugin({
    id,
    version: "1.0.0",
    layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(point, handler, { order }))),
  });
const invoke = (value: number) => Effect.flatMap(Hooks, (hooks) => hooks.invoke(point, value, (input) => Effect.succeed(input * 2)));

describe("plugin-owned hooks", () => {
  test("no listeners calls the terminal; order is explicit and independent of mounting order", async () => {
    const seen: string[] = [];
    const a = middleware("a", (input, next) =>
      Effect.gen(function* () {
        seen.push("a+");
        const value = yield* next(input + 1);
        seen.push("a-");
        return value + 10;
      }),
    );
    const b = middleware("b", (input, next) =>
      Effect.gen(function* () {
        seen.push("b+");
        const value = yield* next(input + 2);
        seen.push("b-");
        return value + 20;
      }),
    );
    const first = middleware(
      "z-first",
      (input, next) =>
        Effect.sync(() => {
          seen.push("first");
        }).pipe(Effect.andThen(next(input))),
      -1,
    );
    await run(
      Effect.gen(function* () {
        const empty = yield* makeCore([]);
        expect(yield* empty.run(invoke(2))).toBe(4);
        const core = yield* makeCore([b, first, a]);
        expect(yield* core.run(invoke(2))).toBe(40);
        expect(seen).toEqual(["first", "a+", "b+", "b-", "a-"]);
        expect((yield* core.inspect).hooks[0]?.handlers.map((handler) => handler.pluginId)).toEqual(["z-first", "a", "b"]);
      }),
    );
  });

  test("short circuit skips downstream handlers and the terminal", async () => {
    let called = false;
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([
          middleware("first", () => Effect.succeed(99)),
          middleware("second", (input, next) => {
            called = true;
            return next(input);
          }),
        ]);
        expect(yield* core.run(invoke(1))).toBe(99);
        expect(called).toBe(false);
      }),
    );
  });

  test("preserves typed failures and defects instead of converting them to successful results", async () => {
    await run(
      Effect.gen(function* () {
        const failed = yield* makeCore([middleware("failure", () => Effect.fail("denied"))]);
        expect(failure(yield* Effect.exit(failed.run(invoke(1))))).toBe("denied");
        const broken = yield* makeCore([
          middleware("defect", () => {
            throw new Error("broken");
          }),
        ]);
        const exit = yield* Effect.exit(broken.run(invoke(1)));
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("broken");
      }),
    );
  });

  test("captures each plugin's dependencies and retains terminal caller dependencies", async () => {
    class Multiplier extends Context.Service<Multiplier, number>()("test/Multiplier") {}
    class Request extends Context.Service<Request, number>()("test/Request") {}
    const dependency = definePlugin({ id: "dependency", provides: [Multiplier], layer: Layer.succeed(Multiplier, 3) });
    const consumer = definePlugin({
      id: "consumer",
      requires: [Multiplier],
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(point, (input, next) =>
            Effect.gen(function* () {
              expect((yield* PluginContext).id).toBe("consumer");
              return yield* next(input * (yield* Multiplier));
            }),
          );
        }),
      ),
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([consumer, dependency]);
        const call = Effect.flatMap(Hooks, (hooks) => hooks.invoke(point, 2, (value) => Effect.map(Request, (request) => value + request)));
        expect(yield* core.run(call).pipe(Effect.provideService(Request, 4))).toBe(10);
      }),
    );
  });

  test("a handler registered after activation runs with its plugin's own services, not those of the work that registered it", async () => {
    const Origin = Context.Reference<string | undefined>("test/LazyOrigin", { defaultValue: () => undefined });
    class Internal extends Context.Service<Internal, string>()("test/Internal") {}
    class Lazy extends Context.Service<Lazy, { readonly register: Effect.Effect<void, unknown, Internal | PluginContext> }>()("test/Lazy") {}
    const ask = Hook.make<string, string>("test/lazy-ask");
    const kick = Hook.make<string, string>("test/lazy-kick");
    const describe: Handler<string, string, never, PluginContext | Internal> = () =>
      Effect.gen(function* () {
        return `${(yield* PluginContext).id}/${yield* Internal}/${(yield* Origin) ?? "none"}`;
      });
    const lazy = definePlugin({
      id: "lazy",
      provides: [Lazy],
      layer: Layer.effect(
        Lazy,
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          // Registered while activating, where its layer provides Internal: so its later handlers have Internal too.
          yield* owner.on(kick, (input, next) => next(input).pipe(Effect.tap(() => Internal)));
          return { register: owner.on(ask, describe) };
        }),
      ).pipe(Layer.provide(Layer.succeed(Internal, "internal"))),
    });
    // Another plugin's handler makes it register, during an operation of its own.
    const trigger = definePlugin({
      id: "trigger",
      requires: [Lazy],
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const { register } = yield* Lazy;
          yield* owner.on(kick, (input, next) => register.pipe(Effect.provideService(Internal, "foreign"), Effect.orDie, Effect.andThen(next(input))), {
            order: -1,
          });
        }),
      ),
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([lazy, trigger]);
        const invoke = (hook: Hook<string, string>) => core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(hook, "x", Effect.succeed)));
        yield* invoke(kick).pipe(Effect.provideService(Origin, "first"));
        expect(yield* invoke(ask).pipe(Effect.provideService(Origin, "second"))).toBe("lazy/internal/second");
        expect(yield* invoke(ask)).toBe("lazy/internal/none");
      }),
    );
  });

  test("rejects different tokens with the same name and invalid ordering", async () => {
    const other = Hook.make<string, string>(point.name);
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([middleware("one", (input, next) => next(input))]);
        const exit = yield* Effect.exit(core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(other, "x", Effect.succeed))));
        expect(failure(exit)).toMatchObject({ _tag: "HookError", reason: "PointConflict" });
        const invalid = yield* Effect.exit(makeCore([middleware("invalid", (input, next) => next(input), NaN)]));
        const error = failure(invalid);
        expect(error._tag).toBe("PluginFault");
        if (error._tag === "PluginFault") {
          expect(Option.getOrThrow(Cause.findErrorOption(error.cause))).toMatchObject({ reason: "InvalidOrder" });
        }
      }),
    );
  });

  test("next cannot execute twice, even when the same lazy Effect is reused", async () => {
    let calls = 0;
    const twice = middleware("twice", (input, next) => {
      const continuation = next(input);
      return continuation.pipe(Effect.andThen(continuation));
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([twice]);
        const exit = yield* Effect.exit(
          core.run(
            Effect.flatMap(Hooks, (hooks) =>
              hooks.invoke(point, 1, (value) =>
                Effect.sync(() => {
                  calls++;
                  return value;
                }),
              ),
            ),
          ),
        );
        expect(failure(exit)).toMatchObject({ _tag: "HookError", reason: "NextAlreadyCalled", pluginId: "twice" });
        expect(calls).toBe(1);
      }),
    );
  });

  test("escaped next cannot execute after its handler returns", async () => {
    let saved!: Next<number, number, string>;
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([
          middleware("capture", (_input, next) => {
            saved = next;
            return Effect.succeed(0);
          }),
        ]);
        yield* core.run(invoke(1));
        expect(failure(yield* Effect.exit(saved(1)))).toMatchObject({ reason: "InvocationEnded" });
      }),
    );
  });

  test("a call sees a registration snapshot; additions affect the next call", async () => {
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let owner!: Context.Service.Shape<typeof PluginContext>;
        const plugin = definePlugin({
          id: "dynamic",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              owner = yield* PluginContext;
              yield* owner.on(point, (input, next) =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(next(input))),
              );
            }),
          ),
        });
        const core = yield* makeCore([plugin]);
        const first = yield* Effect.forkChild(core.run(invoke(1)));
        yield* Deferred.await(entered);
        yield* owner.on(point, (input, next) => next(input + 10));
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBe(2);
        expect(yield* core.run(invoke(1))).toBe(22);
      }),
    );
  });

  test("interruption unwinds middleware and expired owners cannot register", async () => {
    let cleaned = false;
    let owner!: Context.Service.Shape<typeof PluginContext>;
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const plugin = definePlugin({
          id: "waiting",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              owner = yield* PluginContext;
              yield* owner.on(point, (_input, _next) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      cleaned = true;
                    }),
                  ),
                ),
              );
            }),
          ),
        });
        const core = yield* makeCore([plugin]);
        const fiber = yield* Effect.forkChild(core.run(invoke(1)));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(cleaned).toBe(true);
      }),
    );
    expect(failure(await Effect.runPromiseExit(owner.on(point, (input, next) => next(input))))).toMatchObject({ _tag: "CoreClosed" });
  });

  test("spans attribute plugin work and nest under the invocation, not activation", async () => {
    const spans: Tracer.Span[] = [];
    await Effect.runPromise(
      Tracer.Tracer.use((base) => {
        const tracer = Tracer.make({
          ...(base.context === undefined ? {} : { context: base.context }),
          span(options) {
            const span = base.span(options);
            spans.push(span);
            return span;
          },
        });
        return Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([
              middleware("outer", (input, next) => next(input), -1),
              middleware("inner", (input, next) => Effect.flatMap(PluginContext, (owner) => owner.trace("custom", next(input)))),
            ]);
            yield* core.run(invoke(1)).pipe(Effect.withSpan("request"));
          }),
        ).pipe(Effect.withTracer(tracer));
      }),
    );
    const request = spans.find((span) => span.name === "request")!;
    const outer = spans.find((span) => span.name === "core.hook" && span.attributes.get("plugin.id") === "outer")!;
    const inner = spans.find((span) => span.name === "core.hook" && span.attributes.get("plugin.id") === "inner")!;
    const custom = spans.find((span) => span.name === "custom")!;
    expect(Option.getOrThrow(outer.parent).spanId).toBe(request.spanId);
    expect(Option.getOrThrow(inner.parent).spanId).toBe(outer.spanId);
    expect(Option.getOrThrow(custom.parent).spanId).toBe(inner.spanId);
    expect(custom.attributes.get("plugin.version")).toBe("1.0.0");
    expect(spans.filter((span) => span.name === "core.activate").length).toBe(2);
    expect(spans.filter((span) => span.name === "core.dispose").length).toBe(2);
    expect(spans.every((span) => span.status._tag === "Ended")).toBe(true);
  });
});
