import { Effect, Stream } from "effect";
import { definePlugin, Registries } from "@lemma/core";
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
  provides: { slots: Slots },
  setup: function* (_, context) {
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
    return { slots: createSlots(registries, context, run, watch) };
  },
});
