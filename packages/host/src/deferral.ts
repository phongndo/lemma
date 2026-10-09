import { isDeepStrictEqual } from "node:util";
import { Duration, Effect } from "effect";
import { Admitted } from "@lemma/core";
import type { Plugin } from "@lemma/core";

/** How long a change that restarts the transport waits, once the work asking for it has ended, for its reply to leave. */
const REPLY = Duration.millis(250);

/**
 * When a change that restarts the plugins `restarts` may apply, asked from
 * the work making it: `undefined` for at once, or what to wait for first.
 *
 * Applied at once, a change that restarts a plugin whose work is making it
 * would wait on that work, or cut it off. Work run with a plugin's items
 * (`Admitted`, as a channel call it serves is) holds that plugin's disposal,
 * which would wait on the change waiting on it until the dispose deadline:
 * the change waits for the work to end instead. A request the transport
 * serves itself is no such work, and the transport's disposal would drop its
 * reply: a change restarting one of `serving` waits a moment for it to leave.
 */
export const deferral = (restarts: ReadonlySet<string>, serving: readonly string[]): Effect.Effect<Effect.Effect<void> | undefined> =>
  Effect.map(Admitted, (admitted) => {
    // Outermost first: the first such work ends after everything it runs within it.
    const work = admitted.find((entry) => restarts.has(entry.pluginId));
    const replying = serving.some((id) => restarts.has(id));
    if (work === undefined && !replying) return undefined;
    return Effect.andThen(work?.ended ?? Effect.void, replying ? Effect.sleep(REPLY) : Effect.void);
  });

/** What a composition runs: each plugin's definition and config, by id. */
export type Running = ReadonlyMap<string, { readonly plugin: Plugin; readonly config?: unknown }>;

/**
 * The plugins that applying `next` in place of `current` starts, stops, or
 * replaces, as the loader decides it: one added or removed, or one whose
 * definition or config differs. What needs them restarts with them
 * (`restartedBy`).
 */
export const changedBetween = (current: Running, next: Running): string[] =>
  [...new Set([...current.keys(), ...next.keys()])].filter((id) => {
    const was = current.get(id);
    const is = next.get(id);
    return was === undefined || is === undefined || was.plugin !== is.plugin || !isDeepStrictEqual(was.config, is.config);
  });
