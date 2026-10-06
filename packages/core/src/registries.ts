import { Context } from "effect";
import type { Effect, Stream } from "effect";

const RegistryTypeId: unique symbol = Symbol("@lemma/core/Registry");

export interface RegistryOptions<Item> {
  /** Names an item. With `unique`, one plugin at a time may contribute an item under a name. */
  readonly key?: (item: Item) => string;
  /** Adding an item whose key another plugin holds fails with `RegistryError` ("Conflict"). Requires `key`. */
  readonly unique?: boolean;
}

/**
 * A collection plugins contribute to: the things a plugin offers, as opposed
 * to operations it intercepts (a hook) or news it reports (an event). An item
 * belongs to the plugin that added it and leaves when that plugin's scope
 * closes, so nothing outlives its contributor. Share this token with
 * contributors and readers; a name may identify only one token per core.
 */
export interface Registry<Item> {
  readonly name: string;
  readonly options: RegistryOptions<Item>;
  readonly [RegistryTypeId]: (_: Item) => Item;
}

export const Registry = {
  make<Item>(name: string, options: RegistryOptions<Item> = {}): Registry<Item> {
    return Object.freeze({ name, options: Object.freeze({ ...options }) }) as Registry<Item>;
  },
};

export interface ContributeOptions {
  /** Lower values come first; ties use plugin id, then that plugin's contribution order. */
  readonly order?: number;
}

/** An item as readers see it, with who contributed it. */
export interface Contribution<Item> {
  readonly item: Item;
  readonly pluginId: string;
  readonly order: number;
}

/** Reading registries; contributing goes through `PluginContext.add`. */
export class Registries extends Context.Service<
  Registries,
  {
    /** The visible items, in order. A plugin's items appear when it is published and leave when it is retired. */
    readonly items: <I>(registry: Registry<I>) => Effect.Effect<readonly Contribution<I>[]>;
    /** The visible items now, then again after each change; a slow reader sees the latest, never a backlog. */
    readonly changes: <I>(registry: Registry<I>) => Stream.Stream<readonly Contribution<I>[]>;
  }
>()("@lemma/core/Registries") {}
