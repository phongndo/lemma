import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { definePlugin, Diagnostic, makeLoader } from "@lemma/core";
import type { Composition, Plugin } from "@lemma/core";
import { Formatter, Message } from "./contracts.js";

const active = new Set<string>();
const closed: string[] = [];
let consumerStarts = 0;

const provider = (id: string, format: (text: string) => string) =>
  definePlugin({
    id,
    provides: [Formatter],
    layer: Layer.scoped(
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
  layer: Layer.scoped(
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
