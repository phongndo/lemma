import { Context, Effect, Layer, Schema, Scope } from "effect";
import { definePlugin, Event, Events, Hook, Hooks, makeLoader, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";

class Label extends Context.Tag("ui/Label")<Label, string>() {}
const Format = Hook.make<string, string>("ui/format");
const Click = Event.make<number>("ui/click");
const root = document.querySelector("main")!;
const status = document.querySelector("output")!;
const ensure = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
let clicks = 0;
let notifications = 0;
let mounts = 0;
let removals = 0;

async function verify() {
  for (let cycle = 0; cycle < 2; cycle++) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const label = definePlugin({
            id: "label",
            provides: [Label],
            config: Schema.Struct({ text: Schema.String }),
            layer: ({ text }) => Layer.succeed(Label, text),
          });
          const view = definePlugin({
            id: "view",
            requires: [Label],
            exclusive: true,
            layer: Layer.scopedDiscard(
              Effect.gen(function* () {
                const text = yield* Label;
                const owner = yield* PluginContext;
                const events = yield* Events;
                const scope = yield* Scope.Scope;
                const button = document.createElement("button");
                button.textContent = text;
                const click = () => {
                  clicks++;
                  void Effect.runPromise(events.publish(Click, clicks));
                };
                button.addEventListener("click", click);
                root.append(button);
                mounts++;
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => {
                    button.removeEventListener("click", click);
                    button.remove();
                    removals++;
                  }),
                );
                yield* owner.on(Format, (input, next) => next(`${text}:${input}`));
                yield* owner.observe(Click, () =>
                  Effect.sync(() => {
                    notifications++;
                  }),
                );
              }),
            ),
          });
          const broken = definePlugin({
            id: "observer",
            layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.observe(Click, () => Effect.fail("isolated UI observer failure")))),
          });
          const definitions: Record<string, Plugin> = { label, view, observer: broken };
          const composition = (text: string) => ({ plugins: { label: { config: { text } }, view: {}, observer: {} } });
          const loader = yield* makeLoader({ source: { resolve: (id) => Effect.succeed(definitions[id]!) }, composition: composition("First") });
          const invoke = loader.core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Format, "hello", Effect.succeed)));
          ensure((yield* invoke) === "First:hello", "initial hook uses UI contribution");
          const oldButton = root.querySelector("button")!;
          oldButton.click();
          yield* loader.core.inspect.pipe(
            Effect.repeat({ until: (snapshot) => snapshot.plugins.find((p) => p.id === "observer")?.fault?.phase === "observe" }),
            Effect.timeout("2 seconds"),
          );
          yield* loader.apply(composition("Second"));
          ensure((yield* invoke) === "Second:hello", "replacement updates hook and capability");
          ensure(root.querySelectorAll("button").length === 1, "replacement leaves one DOM contribution");
          const before = clicks;
          oldButton.click();
          ensure(clicks === before, "retired button listener was removed");
          root.querySelector("button")!.click();
          yield* Effect.sync(() => notifications).pipe(Effect.repeat({ until: (count) => count === clicks }), Effect.timeout("2 seconds"));
          ensure(
            (yield* loader.core.inspect).plugins.every((plugin) => plugin.state === "active"),
            "observer failure stays isolated",
          );
        }),
      ),
    );
    ensure(root.children.length === 0, "shutdown removes DOM contributions");
  }
  ensure(clicks === 4 && notifications === 4, "remounting does not duplicate handlers");
  ensure(mounts === 4 && removals === 4, "every view is disposed once");
  return { clicks, notifications, mounts, removals };
}

try {
  const result = await verify();
  status.textContent = JSON.stringify(result);
  document.body.dataset.status = "passed";
} catch (error) {
  status.textContent = String(error);
  document.body.dataset.status = "failed";
  console.error(error);
}
