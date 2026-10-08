import { Context } from "effect";
import type { Effect, Stream } from "effect";
import type { RegistryError } from "./errors.ts";
import { token } from "./internal/tokens.ts";

const RegistryTypeId: unique symbol = Symbol("@lemma/core/Registry");

export interface RegistryOptions<Item> {
  /** Names an item. With `unique`, one plugin at a time may contribute an item under a name. */
  readonly key?: (item: Item) => string;
  /** Adding an item whose key another plugin holds fails with `RegistryError` ("Conflict"). Requires `key`. */
  readonly unique?: boolean;
  /**
   * Why a value cannot be an item, or `undefined` when it can. It sees what
   * was added, typed or not, before `key` does; a value it refuses fails `add`
   * with `RegistryError` ("Invalid") for the plugin adding it, and never
   * reaches readers.
   */
  readonly check?: (value: unknown) => string | undefined;
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
    return token(Object.freeze({ name, options: Object.freeze({ ...options }) })) as Registry<Item>;
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

/** Work `Registries.run` admitted, as work running within it finds it (`Admitted`). */
export interface AdmittedWork {
  /** The plugin whose item the work runs with: that plugin's disposal waits for the work. */
  readonly pluginId: string;
  /** Completes once the work has ended, however it ended. */
  readonly ended: Effect.Effect<void>;
}

/**
 * The work `Registries.run` admitted that the current work runs within,
 * outermost first; empty outside any. A plugin's disposal waits for its
 * admitted work, so that work must not wait for the disposal: it would wait
 * on itself until the dispose deadline. Code that replaces plugins on request
 * (an application's reload) reads this to tell whose work is asking, and
 * leaves a change that would replace one of those plugins until its work has
 * `ended`.
 */
export const Admitted = Context.Reference<readonly AdmittedWork[]>("@lemma/core/Admitted", { defaultValue: () => [] });

/** Reading registries, and running work with what they hold; contributing goes through `PluginContext.add`. */
export class Registries extends Context.Service<
  Registries,
  {
    /** The visible items, in order. A plugin's items appear when it is published and leave when it is retired. */
    readonly items: <I>(registry: Registry<I>) => Effect.Effect<readonly Contribution<I>[]>;
    /** The visible items now, then again after each change; a slow reader sees the latest, never a backlog. */
    readonly changes: <I>(registry: Registry<I>) => Stream.Stream<readonly Contribution<I>[]>;
    /**
     * Runs `work` with a contribution, as part of its contributor's lifetime.
     * It is admitted only while the contribution is there, checked in the same
     * step (otherwise `RegistryError` "Absent"). `left` completes when the
     * contribution leaves: removed, its plugin retired, failed, or stopped, or
     * the core closing, and is heard once the change that removed it is
     * complete. Work that must not outlive it stops then; other work
     * may finish. The contributor's disposal waits for admitted work before its
     * finalizers run, for at most the core's dispose deadline, then interrupts
     * it, and `run` fails `RegistryError` ("Expired"). The work runs on its own
     * fiber, with the caller's context, and finds itself in `Admitted`;
     * interrupting `run` interrupts it.
     */
    readonly run: <I, A, E, R>(
      contribution: Contribution<I>,
      work: (left: Effect.Effect<void>) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RegistryError, R>;
    /**
     * Completes once no change to the composition is under way: at once when
     * none is, else once the one in progress has finished, its replacements
     * published or failed and what it replaced disposed. Changes run one at a
     * time, each bounded by the core's deadlines. A contribution leaves while
     * the change that removes it runs, and what replaces it may come only
     * later in that change (an `exclusive` plugin's replacement starts once
     * its predecessor is disposed): work its leaving ended waits for this, then
     * looks again for what is offered now, which is then what that change left.
     * Never wait for it within a change (a plugin starting or stopping) or
     * within work `run` admitted, which a change disposing its contributor
     * waits for: each would wait on the other until a deadline. Interrupting
     * the wait ends it.
     */
    readonly settled: Effect.Effect<void>;
  }
>()("@lemma/core/Registries") {}
