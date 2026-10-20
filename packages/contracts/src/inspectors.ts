import { Cause, Effect, Schema } from "effect";
import type { Context } from "effect";
import { awaitable, Registry } from "@lemma/core";
import type { Awaitable, Registries } from "@lemma/core";
import { HostError } from "./status.ts";

/**
 * A look into a host plugin as it runs (its tools, its running turns): what
 * the devtools' Host inspectors panel and `lemma inspectors` show. A plugin adds
 * one to `Inspectors` with `PluginContext.add`; it belongs to that plugin and
 * leaves with it. Nothing has to provide anything for it to be added. Whoever
 * reaches the host reads it, an agent's script too, so it shows no credential.
 */
export interface Inspector {
  /** Unique across plugins by convention: `<plugin>.<what>` (`tools.registered`). */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /**
   * What it shows now, as plain JSON: one JSON cannot carry as it is (a
   * `BigInt`, a `Date`, an `undefined` field) fails its request. An array of
   * flat objects reads as a table; an object of those, as tables by key. An
   * Effect run each time it is read, or a function returning the snapshot, a
   * promise of it, or an Effect, so a plugin written with promises adds one
   * too. Read it with `snapshotOf`.
   */
  readonly snapshot: Effect.Effect<unknown> | (() => Awaitable<unknown>);
}

/** What an inspector shows now, however it gives it (see `Inspector.snapshot`). */
export const snapshotOf = (inspector: Inspector): Effect.Effect<unknown> => {
  const snapshot = inspector.snapshot;
  // An Effect first: some Effects (a service's tag) are functions too. A function is called on its inspector.
  if (Effect.isEffect(snapshot)) return snapshot;
  return awaitable(() => (snapshot as () => Awaitable<unknown>).call(inspector));
};

/**
 * What a plugin shows of its own state to `lemma inspect` and the devtools: `PluginContext.add(Inspectors,
 * inspector)`.
 *
 * @composition all inspectors; the first with an id answers for it. One whose snapshot fails says so to whoever
 * asked, and never takes the transport with it.
 */
export const Inspectors = Registry.make<Inspector>("lemma/inspectors", { key: (inspector) => inspector.id });

/** An inspector as clients list it: `source` is the plugin that added it. */
export const InspectorInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.String,
});
export type InspectorInfo = typeof InspectorInfo.Type;

/** What `registries` holds of `Inspectors`, as clients list them: what `Host.Inspectors` answers. */
export const listInspectors = (registries: Context.Service.Shape<typeof Registries>): Effect.Effect<InspectorInfo[]> =>
  Effect.map(registries.items(Inspectors), (items) =>
    items.map(({ item, pluginId }) => ({
      id: item.id,
      title: item.title,
      ...(item.description === undefined ? {} : { description: item.description }),
      source: pluginId,
    })),
  );

/** A snapshot as JSON can carry it, as it is: the protocol would refuse one it cannot as a defect. */
const asJson = Schema.encodeUnknownEffect(Schema.toCodecJson(Schema.Unknown));

/** Inspector `id`'s snapshot as JSON, `null` for none (`Host.Inspect`): `NotFound`, or `Failed` when it fails, dies, or is not JSON. */
export const inspectorSnapshot = (registries: Context.Service.Shape<typeof Registries>, id: string): Effect.Effect<unknown, HostError> =>
  Effect.flatMap(registries.items(Inspectors), (items) => {
    const found = items.find((contribution) => contribution.item.id === id)?.item;
    if (found === undefined) return Effect.fail(new HostError({ code: "NotFound", subject: id, message: `No inspector "${id}"` }));
    return snapshotOf(found).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(new HostError({ code: "Failed", subject: id, message: error instanceof Error ? error.message : String(error) }));
      }),
      Effect.flatMap((snapshot) =>
        snapshot === undefined
          ? Effect.succeed(null)
          : asJson(snapshot).pipe(
              Effect.mapError(
                (error) => new HostError({ code: "Failed", subject: id, message: `Inspector "${id}"'s snapshot cannot be sent: ${error.message}` }),
              ),
            ),
      ),
    );
  });
