// Checked by core:check, not executed. These assertions protect the public seam.
import { Context, Effect, Layer, Schema } from "effect";
import { definePlugin, Event, Events, Hook, Hooks, makeCore, PluginContext } from "../src/index.ts";

class Value extends Context.Service<Value, string>()("types/Value") {}
class Other extends Context.Service<Other, number>()("types/Other") {}

export function contracts() {
  const provider = definePlugin({ id: "value", provides: [Value], layer: Layer.succeed(Value, "value") });
  definePlugin({
    id: "missing-input",
    // @ts-expect-error Value must be declared in requires or supplied within the Layer.
    layer: Layer.effectDiscard(Value),
  });
  definePlugin({
    id: "wrong-output",
    provides: [Value],
    // @ts-expect-error The Layer does not provide Value.
    layer: Layer.succeed(Other, 1),
  });
  definePlugin({
    id: "valid-consumer",
    requires: [Value],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Value;
        yield* PluginContext;
        yield* Hooks;
      }),
    ),
  });

  const Settings = Schema.Struct({ greeting: Schema.String });
  definePlugin({
    id: "configured",
    config: Settings,
    provides: [Value],
    layer: (config) => Layer.succeed(Value, config.greeting),
  });
  definePlugin({
    id: "misconfigured",
    config: Settings,
    provides: [Value],
    // @ts-expect-error The decoded config has no such field.
    layer: (config) => Layer.succeed(Value, config.missing),
  });

  const Tick = Event.make<{ readonly at: number }>("types/tick");
  definePlugin({
    id: "observer",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        yield* owner.observe(Tick, (payload) => Effect.log(payload.at));
        // @ts-expect-error Payload does not match the shared event token.
        yield* owner.observe(Tick, (payload) => Effect.log(payload.missing));
        yield* owner.background(
          "ticker",
          Effect.flatMap(Events, (events) => events.publish(Tick, { at: 0 })),
        );
      }),
    ),
  });

  const point = Hook.make<string, number, "rejected">("types/length");
  const calls = Effect.gen(function* () {
    const hooks = yield* Hooks;
    yield* hooks.invoke(point, "hello", (input) => Effect.succeed(input.length));
    // @ts-expect-error Input does not match the shared hook token.
    yield* hooks.invoke(point, 42, () => Effect.succeed(1));
    // @ts-expect-error Output does not match the shared hook token.
    yield* hooks.invoke(point, "hello", () => Effect.succeed("wrong"));
    const owner = yield* PluginContext;
    // @ts-expect-error Handler failures must satisfy the hook's declared error contract.
    yield* owner.on(point, () => Effect.fail("not-declared" as const));
  });

  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([provider]);
        const value: string = yield* core.run(Value);
        // @ts-expect-error Other remains an unsatisfied caller requirement.
        Effect.runPromise(core.run(Other));
        return value;
      }),
    ),
  );
  return calls;
}
