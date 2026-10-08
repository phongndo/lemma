import { Cause, Deferred, Effect, Exit, Fiber, Order, Queue, Scope, Stream } from "effect";
import type { Context } from "effect";
import { CoreClosed, RegistryError } from "../errors.ts";
import type { PluginContext, PluginIdentity } from "../hooks.ts";
import { Admitted } from "../registries.ts";
import type { ContributeOptions, Contribution, Registries, Registry } from "../registries.ts";

interface Entry {
  readonly token: object;
  readonly name: string;
  readonly key: ((item: unknown) => string) | undefined;
  readonly check: ((value: unknown) => string | undefined) | undefined;
  readonly unique: boolean;
  /** Visible, sorted; readers get this array, which is replaced, never changed. */
  visible: readonly Contribution<unknown>[];
  all: Item[];
  readonly listeners: Set<(items: readonly Contribution<unknown>[]) => void>;
}

interface Owner {
  readonly identity: PluginIdentity;
  /** Hidden while staged or retired: readers do not see the items. */
  visible: boolean;
  accepting: boolean;
  /** Work `run` admitted with this instance's items, until it ends. */
  readonly admitted: Set<Admission>;
  /** Completed when `admitted` empties, once its disposal waits for that. */
  idle: Deferred.Deferred<void> | undefined;
}

interface Item {
  readonly owner: Owner;
  readonly entry: Entry;
  readonly contribution: Contribution<unknown>;
  readonly sequence: number;
  readonly key: string | undefined;
  active: boolean;
  /** Set, and `left` completed, when the item leaves for good: removed, retired, stopped, or the store closed. */
  gone: boolean;
  /** Made by the first `run` with the item. */
  left: Deferred.Deferred<void> | undefined;
}

interface Admission {
  /** Unset for the moment between admission and fork. */
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  /** Interrupted at its contributor's dispose deadline: `run` reports "Expired". */
  expired: boolean;
  /** The work has ended, and `waiting` (made only once something waits for that) is complete. */
  ended: boolean;
  waiting: Deferred.Deferred<void> | undefined;
}

/** The item will not be visible again; work running with it hears so through `left`. */
const leave = (item: Item): void => {
  if (item.gone) return;
  item.gone = true;
  if (item.left !== undefined) Deferred.doneUnsafe(item.left, Effect.void);
};

export interface RegistrySnapshot {
  readonly name: string;
  readonly items: readonly {
    readonly pluginId: string;
    readonly order: number;
    readonly key?: string;
  }[];
}

/** One plugin instance's contributions; the same lifecycle as its hook handlers (see `OwnerHandle` in hooks.ts). */
export interface ContributorHandle {
  readonly add: Context.Service.Shape<typeof PluginContext>["add"];
  readonly publish: () => void;
  readonly retire: () => void;
  readonly stop: () => void;
  /** Whether work `run` admitted with this instance's items is running. */
  readonly working: () => boolean;
  /** Resolves once no work `run` admitted with this instance's items is running. */
  readonly idle: Effect.Effect<void>;
  /** Interrupts that work, which `run` then reports as "Expired", and waits for it; returns how much there was. */
  readonly expire: Effect.Effect<number>;
}

/** Contributions change only when plugins add, remove, or change lifecycle; readers get immutable arrays. */
export class RegistryStore implements Context.Service.Shape<typeof Registries> {
  private readonly entries = new Map<string, Entry>();
  /** The item behind each contribution readers are given: `run` takes the contribution. */
  private readonly itemOf = new WeakMap<Contribution<unknown>, Item>();
  private sequence = 0;
  private closed = false;

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      for (const item of entry.all) leave(item);
      entry.all = [];
      update(entry);
    }
    this.entries.clear();
  }

  inspect(): readonly RegistrySnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => entry.visible.length > 0)
      .sort((a, b) => Order.String(a.name, b.name))
      .map((entry) => ({
        name: entry.name,
        items: entry.all
          .filter((item) => item.active && item.owner.visible)
          .sort(byOrder)
          .map((item) => ({ pluginId: item.owner.identity.id, order: item.contribution.order, ...(item.key === undefined ? {} : { key: item.key }) })),
      }));
  }

  contributor(identity: PluginIdentity, scope: Scope.Scope, visible: boolean): ContributorHandle {
    const owner: Owner = { identity, visible, accepting: true, admitted: new Set(), idle: undefined };
    const owned = new Set<Item>();
    // One finalizer for all the owner's items, so items added and removed while it runs leave nothing on its scope.
    let swept = false;
    const sweep = Effect.sync(() => {
      const touched = new Set<Entry>();
      for (const item of owned) {
        item.active = false;
        leave(item);
        touched.add(item.entry);
      }
      owned.clear();
      for (const entry of touched) {
        entry.all = entry.all.filter((item) => item.owner !== owner);
        update(entry);
      }
    });
    const add = <I>(registry: Registry<I>, value: I, options: ContributeOptions = {}) =>
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          if (this.closed) return yield* new CoreClosed();
          if (!owner.accepting) return yield* ownerClosed(registry.name, identity.id);
          const order = options.order ?? 0;
          if (!Number.isFinite(order)) {
            return yield* new RegistryError({
              reason: "InvalidOrder",
              registry: registry.name,
              pluginId: identity.id,
              message: "Contribution order must be finite",
            });
          }
          const entry = yield* this.entry(registry);
          const problem = entry.check?.(value);
          if (problem !== undefined) {
            return yield* new RegistryError({
              reason: "Invalid",
              registry: registry.name,
              pluginId: identity.id,
              message: `Invalid item for ${registry.name}: ${problem}`,
            });
          }
          const key = entry.key?.(value);
          if (entry.unique) {
            // Another plugin's item under this key, visible or staged; this plugin's own earlier instance is being replaced.
            const holder = entry.all.find((item) => item.active && item.key === key && (item.owner.identity.id !== identity.id || item.owner === owner));
            if (holder !== undefined) {
              return yield* new RegistryError({
                reason: "Conflict",
                registry: registry.name,
                pluginId: identity.id,
                ...(key === undefined ? {} : { key }),
                holder: holder.owner.identity.id,
                message: `"${key}" is already contributed to ${registry.name} by "${holder.owner.identity.id}"`,
              });
            }
          }
          const item: Item = {
            owner,
            entry,
            contribution: Object.freeze({ item: value, pluginId: identity.id, order }),
            sequence: this.sequence++,
            key,
            active: true,
            gone: false,
            left: undefined,
          };
          if (!swept) {
            yield* Scope.addFinalizer(scope, sweep);
            swept = true;
          }
          entry.all.push(item);
          owned.add(item);
          this.itemOf.set(item.contribution, item);
          update(entry);
          return Effect.sync(() => {
            if (!owned.has(item)) return;
            item.active = false;
            leave(item);
            owned.delete(item);
            entry.all = entry.all.filter((candidate) => candidate !== item);
            update(entry);
          });
        }),
      );
    const each = (change: (item: Item) => void) => {
      const touched = new Set<Entry>();
      for (const item of owned) {
        change(item);
        touched.add(item.entry);
      }
      for (const entry of touched) update(entry);
    };
    return {
      add,
      publish: () => {
        owner.visible = true;
        each(() => {});
      },
      // A retired instance is never published again, so its items have left for good.
      retire: () => {
        owner.accepting = false;
        owner.visible = false;
        each(leave);
      },
      stop: () => {
        owner.accepting = false;
        owner.visible = false;
        each((item) => {
          item.active = false;
          leave(item);
        });
      },
      working: () => owner.admitted.size > 0,
      idle: Effect.suspend(() => {
        if (owner.admitted.size === 0) return Effect.void;
        owner.idle ??= Deferred.makeUnsafe<void>();
        return Deferred.await(owner.idle);
      }),
      expire: Effect.suspend(() => {
        const fibers: Fiber.Fiber<unknown, unknown>[] = [];
        for (const admission of owner.admitted) {
          admission.expired = true;
          if (admission.fiber !== undefined) fibers.push(admission.fiber);
        }
        return Effect.as(Fiber.interruptAll(fibers), owner.admitted.size);
      }),
    };
  }

  readonly run = <I, A, E, R>(
    contribution: Contribution<I>,
    work: (left: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | RegistryError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const item = this.itemOf.get(contribution as Contribution<unknown>);
        // Checked and admitted in one step: nothing can retire the item in between.
        if (item === undefined || item.gone || !item.active || !item.owner.visible) {
          return Effect.fail(
            new RegistryError({
              reason: "Absent",
              registry: item?.entry.name ?? "unknown",
              pluginId: contribution.pluginId,
              message: `The item from "${contribution.pluginId}" is no longer in ${item?.entry.name ?? "its registry"}`,
            }),
          );
        }
        const owner = item.owner;
        const admission: Admission = { fiber: undefined, expired: false, ended: false, waiting: undefined };
        owner.admitted.add(admission);
        // Completing `left` resumes its waiters at once, inside the change that removed the item: they yield, so they
        // act once that change is complete (a non-exclusive replacement published) rather than in the middle of it.
        const left = Effect.andThen(Deferred.await((item.left ??= Deferred.makeUnsafe<void>())), Effect.yieldNow);
        const ended = Effect.suspend(() => (admission.ended ? Effect.void : Deferred.await((admission.waiting ??= Deferred.makeUnsafe<void>()))));
        return Effect.gen(function* () {
          const within = yield* Admitted;
          const admitted = Effect.provideService(work(left), Admitted, [...within, { pluginId: owner.identity.id, ended }]);
          // A child is interruptible: its contributor's deadline can stop it, whatever the caller's interruptibility.
          const fiber = yield* Effect.forkChild(admitted, { startImmediately: true });
          admission.fiber = fiber;
          if (admission.expired) fiber.interruptUnsafe();
          const exit = yield* restore(Fiber.await(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
          if (Exit.isSuccess(exit)) return exit.value;
          if (admission.expired && Cause.hasInterruptsOnly(exit.cause)) {
            return yield* new RegistryError({
              reason: "Expired",
              registry: item.entry.name,
              pluginId: owner.identity.id,
              message: `Work with an item from "${owner.identity.id}" in ${item.entry.name} outlived its plugin's dispose deadline and was interrupted`,
            });
          }
          return yield* Effect.failCause(exit.cause);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              owner.admitted.delete(admission);
              admission.ended = true;
              if (admission.waiting !== undefined) Deferred.doneUnsafe(admission.waiting, Effect.void);
              if (owner.admitted.size === 0 && owner.idle !== undefined) Deferred.doneUnsafe(owner.idle, Effect.void);
            }),
          ),
        );
      }),
    );

  readonly items = <I>(registry: Registry<I>): Effect.Effect<readonly Contribution<I>[]> =>
    Effect.suspend(() =>
      this.closed ? Effect.succeed([]) : Effect.map(Effect.orDie(this.entry(registry)), (entry) => entry.visible as readonly Contribution<I>[]),
    );

  readonly changes = <I>(registry: Registry<I>): Stream.Stream<readonly Contribution<I>[]> =>
    Stream.unwrap(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return Stream.make([] as readonly Contribution<I>[]);
        const entry = yield* Effect.orDie(this.entry(registry));
        return Stream.callback<readonly Contribution<I>[]>(
          (queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const listener = (items: readonly Contribution<unknown>[]) => void Queue.offerUnsafe(queue, items as readonly Contribution<I>[]);
                entry.listeners.add(listener);
                listener(entry.visible);
                return listener;
              }),
              (listener) => Effect.sync(() => entry.listeners.delete(listener)),
            ),
          { bufferSize: 1, strategy: "sliding" },
        );
      }),
    );

  private entry<I>(registry: Registry<I>): Effect.Effect<Entry, RegistryError> {
    return Effect.suspend(() => {
      const existing = this.entries.get(registry.name);
      if (existing) {
        if (existing.token !== registry) {
          return Effect.fail(
            new RegistryError({
              reason: "PointConflict",
              registry: registry.name,
              message: `Different registry tokens use the name "${registry.name}"; import the shared token instead`,
            }),
          );
        }
        return Effect.succeed(existing);
      }
      const { key, unique = false, check } = registry.options;
      if (unique && key === undefined) {
        return Effect.fail(
          new RegistryError({ reason: "MissingKey", registry: registry.name, message: `Registry "${registry.name}" is unique but has no key` }),
        );
      }
      const entry: Entry = {
        token: registry,
        name: registry.name,
        key: key as ((item: unknown) => string) | undefined,
        check,
        unique,
        visible: [],
        all: [],
        listeners: new Set(),
      };
      this.entries.set(registry.name, entry);
      return Effect.succeed(entry);
    });
  }
}

const byOrder = (a: Item, b: Item) =>
  a.contribution.order - b.contribution.order || Order.String(a.owner.identity.id, b.owner.identity.id) || a.sequence - b.sequence;

/** Recomputes the visible array and tells readers, only when what they see changed. */
function update(entry: Entry): void {
  const next = entry.all.filter((item) => item.active && item.owner.visible).sort(byOrder);
  const previous = entry.visible;
  if (next.length === previous.length && next.every((item, index) => item.contribution === previous[index])) return;
  entry.visible = next.map((item) => item.contribution);
  for (const listener of entry.listeners) listener(entry.visible);
}

function ownerClosed(registry: string, pluginId: string): RegistryError {
  return new RegistryError({ reason: "OwnerClosed", registry, pluginId, message: `Plugin "${pluginId}" has closed` });
}
