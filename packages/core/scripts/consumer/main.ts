import assert from "node:assert/strict";
import { Context, Effect, Layer } from "effect";
import { definePlugin, Diagnostic, makeLoader } from "@lemma/core";
import type { ApplicationServices, Composition, Plugin } from "@lemma/core";
import { definePlugin as definePlainPlugin } from "@lemma/core/plain";
import { testPlugin } from "@lemma/core/testing";
import { Formatter, Message } from "./contracts.js";

const active = new Set<string>();
const closed: string[] = [];
let consumerStarts = 0;

const provider = (id: string, format: (text: string) => string) =>
  definePlugin({
    id,
    provides: [Formatter],
    layer: Layer.effect(
      Formatter,
      Effect.gen(function* () {
        active.add(id);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            active.delete(id);
            closed.push(id);
          }),
        );
        return { format: async (text: string) => format(text) };
      }),
    ),
  });

// The same consumer definition works with either provider.
const consumer = definePlugin({
  id: "consumer",
  requires: [Formatter],
  provides: [Message],
  layer: Layer.effect(
    Message,
    Effect.gen(function* () {
      const formatter = yield* Formatter;
      consumerStarts++;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed.push("consumer");
        }),
      );
      return { render: async (text: string) => `Message: ${await formatter.format(text)}` };
    }),
  ),
});

const plugins: Record<string, Plugin> = {
  lower: provider("lower", (text) => text.toLowerCase()),
  upper: provider("upper", (text) => text.toUpperCase()),
  consumer,
};
const composition = (id: string): Composition => ({ plugins: { [id]: {}, consumer: {} } });

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const loader = yield* makeLoader({
        source: {
          resolve: (id) => (plugins[id] ? Effect.succeed(plugins[id]) : Effect.fail(new Diagnostic({ severity: "error", message: `Unknown plugin: ${id}` }))),
        },
        composition: composition("lower"),
      });
      const render = Effect.flatMap(Message, (message) => Effect.promise(() => message.render("Hello")));
      assert.equal(yield* loader.core.run(render), "Message: hello");

      const report = yield* loader.apply(composition("upper"));
      assert.deepEqual(report.started, ["upper"]);
      assert.deepEqual(report.stopped, ["lower"]);
      assert.deepEqual(report.restarted, ["consumer"]);
      assert.deepEqual(report.faults, []);
      assert.equal(yield* loader.core.run(render), "Message: HELLO");
      assert.equal(consumerStarts, 2);
      assert.deepEqual([...active], ["upper"]);
      assert.deepEqual(closed, ["consumer", "lower"]);
    }),
  ),
);

assert.equal(active.size, 0);
assert.deepEqual(closed, ["consumer", "lower", "consumer", "upper"]);
console.log("External consumer: provider replacement and cleanup passed.");

// A capability the application provides itself: built before its plugins, released after them, and never replaced.
{
  const before = closed.length;
  const formatter: ApplicationServices<readonly [typeof Formatter]> = {
    provides: [Formatter],
    layer: Layer.effect(
      Formatter,
      Effect.acquireRelease(Effect.succeed({ format: async (text: string) => `[${text}]` }), () => Effect.sync(() => void closed.push("application"))),
    ),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins[id]!) },
          composition: { plugins: { consumer: {} } },
          provide: formatter,
        });
        const render = Effect.flatMap(Message, (message) => Effect.promise(() => message.render("Hello")));
        assert.equal(yield* loader.core.run(render), "Message: [Hello]");
        assert.deepEqual((yield* loader.core.inspect).provided, [Formatter.key]);
        const refused = yield* Effect.flip(loader.apply({ plugins: { consumer: {}, upper: {} } }));
        assert.match(refused.diagnostics[0]!.message, /the application provides it/);
      }),
    ),
  );
  assert.deepEqual(closed.slice(before), ["consumer", "application"]);
  console.log("External consumer: application-provided capabilities passed.");
}

// The package's other entry points, as a consumer imports them: plugins written with promises, and the test harness.
{
  class Clock extends Context.Service<Clock, { readonly now: () => Effect.Effect<number> }>()("consumer/Clock") {}
  class Stamp extends Context.Service<Stamp, { readonly stamp: (text: string) => string }>()("consumer/Stamp") {}
  const stamper = definePlainPlugin({
    id: "stamper",
    config: { separator: "@" },
    requires: { clock: Clock },
    provides: { stamp: Stamp },
    setup: async ({ clock }, { config }) => {
      const at = await clock.now();
      return { stamp: { stamp: (text: string) => `${text}${config.separator}${at}` } };
    },
  });
  const tested = await testPlugin(stamper, { provide: [[Clock, { now: () => Effect.succeed(7) }]] });
  assert.equal((await tested.get(Stamp)).stamp("a"), "a@7");
  await tested.close();
  console.log("External consumer: @lemma/core/plain and @lemma/core/testing passed.");
}
