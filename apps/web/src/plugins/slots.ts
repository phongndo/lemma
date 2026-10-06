import { Effect, Layer, Stream } from "effect";
import { definePlugin, PluginContext, Registries } from "@lemma/core";
import { Slots } from "../ui/contracts.ts";
import { createSlots } from "../ui/slots.ts";

/**
 * Slots over the core's registries. Written against the kernel directly: it
 * needs the plugin context and registries that `defineUiPlugin` keeps from
 * setups. Replacing it restarts every plugin that contributes, with the new
 * service.
 */
export default definePlugin({
  id: "slots",
  provides: [Slots],
  layer: Layer.effect(
    Slots,
    Effect.gen(function* () {
      const context = yield* PluginContext;
      const registries = yield* Registries;
      const run = Effect.runSyncWith(yield* Effect.context<never>());
      // Each slot's changes feed its signal for as long as this plugin runs.
      const watch = (name: string, changes: Stream.Stream<readonly unknown[]>, apply: (items: any) => void) =>
        run(
          context
            .background(
              `slots ${name}`,
              Stream.runForEach(changes, (items) => Effect.sync(() => apply(items))),
            )
            .pipe(Effect.ignore),
        );
      return createSlots(registries, context, run, watch);
    }),
  ),
});
