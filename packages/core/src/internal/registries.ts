import { Effect, Order, Queue, Scope, Stream } from "effect";
import type { Context } from "effect";
import { CoreClosed, RegistryError } from "../errors.ts";
import type { PluginContext, PluginIdentity } from "../hooks.ts";
import type { ContributeOptions, Contribution, Registries, Registry } from "../registries.ts";

interface Entry {
  readonly token: object;
  readonly name: string;
  readonly key: ((item: unknown) => string) | undefined;
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
}

interface Item {
  readonly owner: Owner;
  readonly entry: Entry;
  readonly contribution: Contribution<unknown>;
  readonly sequence: number;
  readonly key: string | undefined;
  active: boolean;
}

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
}

/** Contributions change only when plugins add, remove, or change lifecycle; readers get immutable arrays. */
export class RegistryStore implements Context.Service.Shape<typeof Registries> {
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;
  private closed = false;

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
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
    const owner: Owner = { identity, visible, accepting: true };
    const owned = new Set<Item>();
    // One finalizer for all the owner's items, so items added and removed while it runs leave nothing on its scope.
    let swept = false;
    const sweep = Effect.sync(() => {
      const touched = new Set<Entry>();
      for (const item of owned) {
        item.active = false;
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
          };
          if (!swept) {
            yield* Scope.addFinalizer(scope, sweep);
            swept = true;
          }
          entry.all.push(item);
          owned.add(item);
          update(entry);
          return Effect.sync(() => {
            if (!owned.has(item)) return;
            item.active = false;
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
      retire: () => {
        owner.accepting = false;
        owner.visible = false;
        each(() => {});
      },
      stop: () => {
        owner.accepting = false;
        owner.visible = false;
        each((item) => {
          item.active = false;
        });
      },
    };
  }

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
      const { key, unique = false } = registry.options;
      if (unique && key === undefined) {
        return Effect.fail(
          new RegistryError({ reason: "MissingKey", registry: registry.name, message: `Registry "${registry.name}" is unique but has no key` }),
        );
      }
      const entry: Entry = {
        token: registry,
        name: registry.name,
        key: key as ((item: unknown) => string) | undefined,
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
