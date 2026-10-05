import { Deferred, Effect } from "effect";

/** Holds at most one slot; `slot` says whether it has one now. */
export interface SlotHolder {
  slot: boolean;
}

/**
 * A fixed number of slots, handed out first come, first served. A holder's
 * flag is set the moment a slot is handed to it, and `release` gives back
 * only a slot the holder has, so a holder can release in an `ensuring` around
 * both its wait and its use: one that stops waiting, or is interrupted at any
 * point, never strands a slot.
 */
export function makeSlots(size: number) {
  let free = size;
  /** Holders waiting, in the order they began (a `Map` keeps insertion order). */
  const waiting = new Map<SlotHolder, Deferred.Deferred<void>>();

  const release = (holder: SlotHolder): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!holder.slot) return Effect.void;
      holder.slot = false;
      const next = waiting.entries().next();
      if (next.done === true) {
        free++;
        return Effect.void;
      }
      const [waiter, handed] = next.value;
      waiting.delete(waiter);
      waiter.slot = true;
      return Deferred.succeed(handed, undefined);
    });

  /** Waits for a slot, unless `until` completes first; true when the holder has one. */
  const take = (holder: SlotHolder, until: Effect.Effect<void>): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      if (holder.slot) return Effect.succeed(true);
      if (free > 0) {
        free--;
        holder.slot = true;
        return Effect.succeed(true);
      }
      return Effect.flatMap(Deferred.make<void>(), (handed) => {
        waiting.set(holder, handed);
        return Effect.raceFirst(Deferred.await(handed), until).pipe(
          Effect.ensuring(Effect.sync(() => waiting.delete(holder))),
          // Handed one as `until` completed: it has it, and uses it.
          Effect.map(() => holder.slot),
        );
      });
    });

  return { take, release };
}
