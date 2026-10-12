import { describe, expect, test } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { definePlugin, Hook, Hooks, makeCore, makeSpanCollector, PluginContext } from "../src/index.ts";
import type { HandlerStep, Handler } from "../src/index.ts";

const point = Hook.make<number, number, string>("test/compute", {
  summary: { input: (input) => ({ value: input }), output: (output) => ({ value: output }) },
});
const middleware = (id: string, handler: Handler<number, number, string, PluginContext | Hooks>, order = 0) =>
  definePlugin({
    id,
    layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(point, handler, { order }))),
  });

describe("span collector", () => {
  test("keeps each span as data: its plugin, the work's attributes, its timing, and a failure in a line", async () => {
    const collector = makeSpanCollector();
    const heard: string[] = [];
    collector.subscribe((spans) => void heard.push(...spans.map((span) => span.name)));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([middleware("adds", (input, next) => next(input + 1)), middleware("fails", () => Effect.fail("no"), 1)]);
          yield* core
            .run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(point, 1, (input) => Effect.succeed(input * 2))))
            .pipe(Effect.withSpan("turn"), Effect.annotateSpans({ "session.id": "s1" }), Effect.ignore);
        }),
      ).pipe(Effect.withTracer(collector.tracer)),
    );
    const spans = collector.spans();
    const turn = spans.find((span) => span.name === "turn")!;
    const hooks = spans.filter((span) => span.name === "core.hook");
    expect(hooks.map((span) => [span.attributes["plugin.id"], span.parentId === turn.id || span.parentId === hooks[1]?.id])).toEqual([
      ["fails", true],
      ["adds", true],
    ]);
    // Every span in the work carries what it was marked with, and a failure says what failed.
    expect(hooks.every((span) => span.attributes["session.id"] === "s1")).toBe(true);
    expect(hooks[0]).toMatchObject({ status: "error", error: expect.stringContaining("no") });
    expect(turn.ms).toBeGreaterThanOrEqual(hooks[1]!.ms);
    expect(spans.filter((span) => span.name === "core.activate")).toHaveLength(2);
    await expect.poll(() => heard.includes("turn")).toBe(true);
  });

  test("keeps only the last spans, as many as its limit", async () => {
    const collector = makeSpanCollector({ limit: 3 });
    await Effect.runPromise(
      Effect.forEach([1, 2, 3, 4, 5, 6, 7], (n) => Effect.void.pipe(Effect.withSpan(`span ${n}`))).pipe(Effect.withTracer(collector.tracer)),
    );
    expect(collector.spans().map((span) => span.name)).toEqual(["span 5", "span 6", "span 7"]);
  });

  test("keeping a span never fails the work it traced, though its failure has no string form", async () => {
    const collector = makeSpanCollector();
    const exit = await Effect.runPromiseExit(Effect.fail(Object.create(null)).pipe(Effect.withSpan("odd"), Effect.withTracer(collector.tracer)));
    // The work failed as it did, with no defect from the tracer.
    expect(Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail"]);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    expect(collector.spans()).toMatchObject([{ name: "odd", status: "error", error: "a failure with no description" }]);
  });
});

describe("hook steps", () => {
  test("say what each handler was handed, passed on, and returned, and how long it took on its own", async () => {
    const steps: HandlerStep<number, number>[] = [];
    const collector = makeSpanCollector();
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([
            middleware("outer", (input, next) => Effect.map(next(input + 1), (result) => result + 100)),
            middleware("inner", (input, next) => next(input * 10), 1),
            middleware("answers", (input) => Effect.succeed(input), 2),
          ]);
          return yield* core.run(
            Effect.flatMap(Hooks, (hooks) => hooks.invoke(point, 1, (input) => Effect.succeed(-input), { onStep: (step) => void steps.push(step) })),
          );
        }),
      ).pipe(Effect.withTracer(collector.tracer)),
    );
    expect(output).toBe(120);
    // The innermost ends first; one that answered itself passed nothing on.
    expect(steps.map(({ pluginId, index, input, next, output, exit }) => ({ pluginId, index, input, next, output, exit }))).toEqual([
      { pluginId: "answers", index: 2, input: 20, next: undefined, output: 20, exit: "success" },
      { pluginId: "inner", index: 1, input: 2, next: { input: 20, output: 20 }, output: 20, exit: "success" },
      { pluginId: "outer", index: 0, input: 1, next: { input: 2, output: 20 }, output: 120, exit: "success" },
    ]);
    for (const step of steps) expect(step.selfMs).toBeLessThanOrEqual(step.ms);
    // While tracing, a hook's summary describes each handler's span: what it was handed, passed on, and returned.
    const outer = collector.spans().find((span) => span.name === "core.hook" && span.attributes["plugin.id"] === "outer")!;
    expect(outer.attributes).toMatchObject({ "hook.in.value": 1, "hook.next.value": 2, "hook.out.value": 120 });
  });

  test("what a handler passed on is on its own span, though it called next inside a span of its own", async () => {
    const collector = makeSpanCollector();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([middleware("wraps", (input, next) => next(input + 1).pipe(Effect.withSpan("mine")))]);
          return yield* core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(point, 1, (input) => Effect.succeed(input))));
        }),
      ).pipe(Effect.withTracer(collector.tracer)),
    );
    const spans = collector.spans();
    expect(spans.find((span) => span.name === "core.hook")!.attributes).toMatchObject({ "hook.in.value": 1, "hook.next.value": 2 });
    expect(spans.find((span) => span.name === "mine")!.attributes).not.toHaveProperty("hook.next.value");
  });

  test("a failing summary or step listener never fails the operation", async () => {
    const fragile = Hook.make<number, number>("test/fragile", {
      summary: {
        input: () => {
          throw new Error("summary");
        },
      },
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([
            definePlugin({
              id: "passes",
              layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(fragile, (input, next) => next(input)))),
            }),
          ]);
          return yield* core.run(
            Effect.flatMap(Hooks, (hooks) =>
              hooks.invoke(fragile, 2, (input) => Effect.succeed(input + 1), {
                onStep: () => {
                  throw new Error("listener");
                },
              }),
            ),
          );
        }),
      ).pipe(Effect.withTracer(makeSpanCollector().tracer)),
    );
    expect(output).toBe(3);
  });
});
