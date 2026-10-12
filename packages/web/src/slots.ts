import { createSignal } from "solid-js";
import type { Accessor, Component, Setter } from "solid-js";
import { Registry } from "@lemma/core";
import type { Contribution, PhaseOptions, PluginContext, Registries } from "@lemma/core";
import { Cause, Effect } from "effect";
import type { Context, Stream } from "effect";

/**
 * A named place plugins contribute to: a region of the screen (items carry a
 * component), or a list the app reads (actions, settings sections, views).
 * `T` is what each item carries. A slot is a core registry: an item belongs to
 * the plugin that added it and leaves with it, and the Plugins page shows who
 * contributes what.
 */
export type Slot<T> = Registry<SlotItem<T>>;

export interface SlotOptions extends PhaseOptions {
  /** `first`: one item shows, the first in order (a region, a part); `all`: every item does, in order (the default). */
  readonly shows?: "first" | "all";
}

/**
 * The phases of a slot that shows one item, unless it declares its own: a bundled plugin adds its default in
 * `default`, and an item naming no phase goes in `replace`, so it shows instead, whatever the numbers.
 */
export const FIRST_WINS: PhaseOptions = Object.freeze({ phases: Object.freeze(["replace", "default"]), defaultPhase: "replace" });

const named = new Map<string, { readonly slot: Slot<any>; readonly shows: "first" | "all"; fallback?: Component<any> }>();

/** The phases a declaration gives its slot; a default phase without phases is passed on, for `Registry.make` to refuse. */
const phasesOf = (options: SlotOptions): PhaseOptions =>
  options.phases !== undefined || options.defaultPhase !== undefined
    ? {
        ...(options.phases === undefined ? {} : { phases: options.phases }),
        ...(options.defaultPhase === undefined ? {} : { defaultPhase: options.defaultPhase }),
      }
    : options.shows === "first"
      ? FIRST_WINS
      : {};

/** A part's slot (`definePart`) is named `part.<name>`. */
const PART = "part.";

/**
 * The slot with this name: the same token each time, so a web half loaded again after an edit, or two files naming
 * one slot, share it. The first declaration fixes what shows and the phases; naming the slot again without options
 * finds it, and with different ones throws, as a slot cannot be two things. A part's slot (`part.<name>`) named
 * without options before its part is declared (one web half adding to another's part, loaded first) is a part's.
 */
export const defineSlot = <T>(name: string, given: SlotOptions = {}): Slot<T> => {
  const found = named.get(name);
  const options: SlotOptions =
    found === undefined && given.shows === undefined && given.phases === undefined && given.defaultPhase === undefined && name.startsWith(PART)
      ? { shows: "first" }
      : given;
  const declared: SlotOptions = { shows: options.shows ?? "all", ...phasesOf(options) };
  if (found === undefined) {
    const slot = Registry.make<SlotItem<any>>(name, { key: (item) => item.id, ...phasesOf(options) });
    named.set(name, { slot, shows: declared.shows! });
    return slot as Slot<T>;
  }
  if (options.shows !== undefined || options.phases !== undefined || options.defaultPhase !== undefined) {
    const { phases, defaultPhase } = found.slot.options;
    const same = declared.shows === found.shows && declared.defaultPhase === defaultPhase && JSON.stringify(declared.phases) === JSON.stringify(phases);
    if (!same) throw new Error(`${name} is declared already, showing ${found.shows}${phases === undefined ? "" : ` in phases ${phases.join(", ")}`}`);
  }
  return found.slot as Slot<T>;
};

/** Every slot defined so far, and whether one item or all of them show (its phases are `slot.options.phases`): what the devtools list. */
export const definedSlots = (): readonly { readonly slot: Slot<unknown>; readonly shows: "first" | "all" }[] => [...named.values()];

/** A region filled by one component: the first item wins. */
export interface Region<P extends Record<string, any> = {}> {
  readonly component: Component<P>;
}

/**
 * A replaceable piece of UI that plugins draw with: a region slot, named
 * `part.<name>`, whose first item renders wherever the part is used (see
 * `ui/parts.tsx`). Its phases are `FIRST_WINS`: the plugin that provides its
 * default adds it in `default`, and a plugin replaces it by adding an item
 * that names no phase; `P` is the props every provider takes.
 *
 * `fallback` renders wherever the part is drawn while no plugin provides it:
 * plain native markup, belonging to no plugin. Without one, a part nothing
 * provides renders nothing. The declaration that gives a fallback fixes it:
 * defining the part again keeps it, and refuses another. A web half's
 * `definePart` (`api.definePart`) takes none, since a part of its own is its
 * plugin's to provide.
 */
export type Part<P extends Record<string, any>> = Slot<Region<P>>;
export const definePart = <P extends Record<string, any>>(name: string, fallback?: Component<P>): Part<P> => {
  const part = defineSlot<Region<P>>(`${PART}${name}`, { shows: "first" });
  if (fallback === undefined) return part;
  const entry = named.get(part.name)!;
  if (entry.fallback !== undefined && entry.fallback !== fallback) throw new Error(`${part.name} has a fallback from its declaration, which nothing changes`);
  entry.fallback = fallback;
  return part;
};

/** What renders for `slot` while nothing provides it: a part's fallback (`definePart`), or undefined. */
export const fallbackOf = (slot: Slot<any>): Component<any> | undefined => named.get(slot.name)?.fallback;

/**
 * Every item has an id, unique within its slot by convention. Items come in
 * the slot's phases' order, when it declares phases (`phase`, its default
 * phase when absent); within a phase, lower `order` comes first, and equal
 * orders go by the contributing plugin's id, then the order that plugin added
 * them in. Where a slot shows one item (a region, a part), the first one
 * does: a plugin takes over a region by adding an item that names no phase,
 * as the bundled default is in `default` (`FIRST_WINS`), or by the bundled
 * plugin being turned off.
 */
export type SlotItem<T> = T & { readonly id: string; readonly phase?: string; readonly order?: number };

type Contributor = Context.Service.Shape<typeof PluginContext>;

export interface SlotsService {
  /**
   * Adds an item as this plugin's; returns its removal. It also leaves when the plugin stops, and an add once it is
   * stopping does nothing. The page's own view belongs to no plugin, and throws: every item has a plugin to leave with.
   */
  readonly add: <T>(slot: Slot<T>, item: SlotItem<T>) => () => void;
  /** The slot's items in order. Reactive. */
  readonly list: <T>(slot: Slot<T>) => readonly SlotItem<T>[];
  /** The first item, or undefined when the slot is empty. Reactive. */
  readonly first: <T>(slot: Slot<T>) => SlotItem<T> | undefined;
  /** The item with this id. Reactive. */
  readonly get: <T>(slot: Slot<T>, id: string) => SlotItem<T> | undefined;
  /** The id of the plugin that added the item with this id (to name it when the item fails). Reactive. */
  readonly owner: <T>(slot: Slot<T>, id: string) => string | undefined;
  /** The id of the plugin that added `item`, while it is in a slot (`Contained` draws it as that plugin's). */
  readonly pluginOf: (item: SlotItem<unknown>) => string | undefined;
  /** The slot's items in order, each with the plugin that added it, its phase (when the slot declares phases), and its order. Reactive. */
  readonly contributions: <T>(
    slot: Slot<T>,
  ) => readonly { readonly item: SlotItem<T>; readonly pluginId: string; readonly phase?: string; readonly order: number }[];
  /**
   * An item that threw while drawing (`Contained` calls this) or as another
   * plugin used it (the keymap running an action): reported as a
   * fault of the plugin that added it, and left out of `list`, `first`, and
   * `get` from then on, so a region shows its next item and a part its default.
   * The item returns when its plugin adds it again (a restart).
   */
  readonly fail: <T>(slot: Slot<T>, item: SlotItem<T>, error: unknown) => void;
  /** The slot's items that failed, with who added each and what it threw. Reactive. */
  readonly failures: <T>(slot: Slot<T>) => readonly SlotFailure<T>[];
  /**
   * The same registry, adding as `contributor`'s: how `defineWebPlugin` hands each plugin its own.
   */
  readonly as: (contributor: Contributor) => SlotsService;
}

/** An item left out of its slot because it threw while drawing. */
export interface SlotFailure<T> {
  readonly item: SlotItem<T>;
  /** The plugin that added it, when known. */
  readonly pluginId?: string;
  readonly error: unknown;
}

/** Runs a synchronous Effect: everything here only reads or changes registries in memory. */
export type RunSync = <A, E>(effect: Effect.Effect<A, E>) => A;

/**
 * Slots over the core's registries, with a Solid signal per slot so views
 * re-render when it changes: from a local add or removal at once, and from a
 * plugin starting or stopping through the registry's change stream, which
 * `watch` follows for as long as the core runs. Returns the page's own view,
 * which reads and refuses to add (see `SlotsService.add`).
 */
export function createSlots(
  registries: Context.Service.Shape<typeof Registries>,
  run: RunSync,
  watch: (name: string, changes: Stream.Stream<readonly Contribution<unknown>[]>, apply: (items: readonly Contribution<unknown>[]) => void) => void,
): SlotsService {
  const signals = new Map<string, readonly [Accessor<readonly Contribution<unknown>[]>, Setter<readonly Contribution<unknown>[]>]>();
  const signal = <T>(slot: Slot<T>) => {
    let found = signals.get(slot.name);
    if (found === undefined) {
      found = createSignal<readonly Contribution<unknown>[]>(run(registries.items(slot)) as readonly Contribution<unknown>[], { equals: false });
      signals.set(slot.name, found);
      const [, set] = found;
      watch(slot.name, registries.changes(slot) as Stream.Stream<readonly Contribution<unknown>[]>, set);
    }
    return found;
  };
  const refresh = <T>(slot: Slot<T>) => signal(slot)[1](run(registries.items(slot)) as readonly Contribution<unknown>[]);
  /** Who added each item last, to report its failures as theirs; a restarted plugin adding it again is a new contributor. */
  const contributors = new WeakMap<object, Contributor>();
  /**
   * Items that threw while drawing, by slot name, each with the plugin instance
   * that had added it: the same item added again by a restart is tried afresh.
   * `failing` changes with it, so readers see an item leave.
   */
  const failed = new Map<string, (SlotFailure<unknown> & { readonly by: Contributor | undefined })[]>();
  const [failing, setFailing] = createSignal(0);
  const stillFailed = (failure: { readonly item: unknown; readonly by: Contributor | undefined }) => contributors.get(failure.item as object) === failure.by;
  const working = (name: string, contribution: Contribution<unknown>) =>
    !(failed.get(name)?.some((failure) => failure.item === contribution.item && stillFailed(failure)) ?? false);
  const visible = <T>(slot: Slot<T>) => {
    const all = signal(slot)[0]();
    failing();
    return failed.has(slot.name) ? all.filter((contribution) => working(slot.name, contribution)) : all;
  };
  const items = <T>(slot: Slot<T>) => visible(slot).map((contribution) => contribution.item as SlotItem<T>);
  const service = (owner: Contributor | undefined): SlotsService => ({
    add: (slot, item) => {
      if (owner === undefined) throw new Error("Slots: add through a plugin's own slots, the ones its setup receives");
      // A stopping plugin's effects can still run; what they add would leave with it at once.
      const remove = run(
        owner.add(slot, item, { ...(item.phase === undefined ? {} : { phase: item.phase }), order: item.order ?? 0 }).pipe(
          Effect.catchIf(
            (error) => error._tag === "CoreClosed" || error.reason === "OwnerClosed",
            () => Effect.succeed(undefined),
          ),
        ),
      );
      if (remove === undefined) return () => {};
      contributors.set(item, owner);
      refresh(slot);
      return () => {
        run(remove);
        refresh(slot);
      };
    },
    fail: (slot, item, error) => {
      const list = (failed.get(slot.name) ?? []).filter(stillFailed);
      if (list.some((failure) => failure.item === item)) return;
      const contributor = contributors.get(item);
      failed.set(slot.name, [...list, { item, error, by: contributor, ...(contributor === undefined ? {} : { pluginId: contributor.id }) }]);
      setFailing((count) => count + 1);
      if (contributor === undefined) console.error(`lemma web: an item of ${slot.name} failed`, error);
      else run(contributor.fault(`draw ${slot.name} "${item.id}"`, Cause.die(error)));
    },
    failures: <T>(slot: Slot<T>) => {
      const all = signal(slot)[0]();
      failing();
      // An item that has left, or that a restart added again, failed no longer.
      const current = (failed.get(slot.name) ?? []).filter((failure) => stillFailed(failure) && all.some((contribution) => contribution.item === failure.item));
      if (current.length === 0) failed.delete(slot.name);
      else failed.set(slot.name, current);
      return current.map(({ by: _, ...failure }) => failure) as unknown as readonly SlotFailure<T>[];
    },
    list: items,
    first: (slot) => items(slot)[0],
    get: (slot, id) => items(slot).find((item) => item.id === id),
    owner: (slot, id) => signal(slot)[0]().find((contribution) => (contribution.item as SlotItem<unknown>).id === id)?.pluginId,
    pluginOf: (item) => contributors.get(item)?.id,
    contributions: <T>(slot: Slot<T>) =>
      signal(slot)[0]().map(({ item, pluginId, phase, order }) => ({ item: item as SlotItem<T>, pluginId, ...(phase === undefined ? {} : { phase }), order })),
    as: service,
  });
  return service(undefined);
}
