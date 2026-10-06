import { Context, Effect, Layer } from "effect";
import { definePlugin, Hook, Hooks, makeCore, PluginContext } from "@lemma/core";
import type { CoreClosed, HookError } from "@lemma/core";

// These contracts belong to plugins, not to the core.
const Greeting = Hook.make<string, string>("example/greeting");
class Greeter extends Context.Service<
  Greeter,
  {
    readonly greet: (name: string) => Effect.Effect<string, CoreClosed | HookError>;
  }
>()("example/Greeter") {}

const greeter = definePlugin({
  id: "greeter",
  version: "1.0.0",
  provides: [Greeter],
  layer: Layer.effect(
    Greeter,
    Effect.gen(function* () {
      const hooks = yield* Hooks;
      const owner = yield* PluginContext;
      return {
        greet: (name: string) =>
          owner.trace(
            "greet",
            hooks.invoke(Greeting, name, (value) => Effect.succeed(`Hello, ${value}`)),
          ),
      };
    }),
  ),
});

const enthusiastic = definePlugin({
  id: "enthusiastic",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const owner = yield* PluginContext;
      yield* owner.on(Greeting, (name, next) => Effect.map(next(name), (message) => `${message}!`));
    }),
  ),
});

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([greeter, enthusiastic]);
      const message = yield* core.run(Effect.flatMap(Greeter, (greeter) => greeter.greet("world")));
      console.log(message);
      // Scope exit cleans up both plugins and their hook registrations.
    }),
  ),
);
