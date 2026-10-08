import { Effect, Stream } from "effect";
import type { Scope } from "effect";
import { Registries } from "@lemma/core";
import type { Contribution } from "@lemma/core";
import { createSlots } from "../ui/slots.ts";
import type { SlotsService } from "../ui/slots.ts";

/**
 * The runtime's `Slots` over this core's registries (`createSlots`), the
 * page's own view. Each slot's changes are followed in the scope building it,
 * the core's application scope, so the watchers end with the core. A reader
 * that throws on a change is logged, and the slot goes on following.
 */
export const makeSlots: Effect.Effect<SlotsService, never, Registries | Scope.Scope> = Effect.gen(function* () {
  const registries = yield* Registries;
  const scope = yield* Effect.scope;
  const run = Effect.runSyncWith(yield* Effect.context<never>());
  const watch = (name: string, changes: Stream.Stream<readonly Contribution<unknown>[]>, apply: (items: readonly Contribution<unknown>[]) => void) =>
    void run(
      Effect.forkIn(
        Stream.runForEach(changes, (items) =>
          Effect.sync(() => {
            try {
              apply(items);
            } catch (error) {
              console.error(`lemma ui: a reader of ${name} failed`, error);
            }
          }),
        ),
        scope,
      ),
    );
  return createSlots(registries, run, watch);
});
