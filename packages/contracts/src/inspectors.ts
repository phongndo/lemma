import { Schema } from "effect";
import type { Effect } from "effect";
import { awaitable, Registry } from "@lemma/core";
import type { Awaitable } from "@lemma/core";

/**
 * A look into a host plugin as it runs (its tools, its running turns): what
 * the devtools' Host inspectors panel and `lemma inspect` show. A plugin adds
 * one to `Inspectors` with `PluginContext.add`; it belongs to that plugin and
 * leaves with it. Nothing has to provide anything for it to be added.
 */
export interface Inspector {
  /** Unique across plugins by convention: `<plugin>.<what>` (`tools.registered`). */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /**
   * What it shows now, as plain JSON. An array of flat objects reads as a
   * table; an object of those, as tables by key. An Effect run each time it
   * is read, or a function returning the snapshot, a promise of it, or an
   * Effect, so a plugin written with promises adds one too. Read it with
   * `snapshotOf`.
   */
  readonly snapshot: Effect.Effect<unknown> | (() => Awaitable<unknown>);
}

/** What an inspector shows now, however it gives it (see `Inspector.snapshot`). */
export const snapshotOf = (inspector: Inspector): Effect.Effect<unknown> =>
  typeof inspector.snapshot === "function" ? awaitable(inspector.snapshot as () => Awaitable<unknown>) : inspector.snapshot;

export const Inspectors = Registry.make<Inspector>("lemma/inspectors", { key: (inspector) => inspector.id });

/** An inspector as clients list it: `source` is the plugin that added it. */
export const InspectorInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.String,
});
export type InspectorInfo = typeof InspectorInfo.Type;
