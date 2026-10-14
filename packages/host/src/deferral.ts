import { Duration, Effect } from "effect";
import { Admitted } from "@lemma/core";

/**
 * How long a change that restarts the transport waits, once the work asking for it has ended, for its reply to leave.
 * A guess, not a signal: see `deferral`.
 */
const REPLY = Duration.millis(250);

/**
 * When a change that restarts the plugins `restarts` may apply, asked from
 * the work making it: `undefined` for at once, or what to wait for first.
 * What a change restarts is the loader's answer (`Loader.affected`).
 *
 * Applied at once, a change that restarts a plugin whose work is making it
 * would wait on that work, or cut it off. Work run with a plugin's items
 * (`Admitted`, as a channel call it serves is) holds that plugin's disposal,
 * which would wait on the change waiting on it until the dispose deadline:
 * the change waits for the work to end instead. A request the transport
 * serves itself is no such work, and the transport's disposal would drop its
 * reply: a change restarting one of `serving` waits `REPLY` for it to leave.
 * That wait is a guess. The reply has left once the transport has written it
 * to its connection, which only the transport knows: the runtime would have
 * to name the transport's domain to ask, and the end of the call is no
 * answer, since the transport writes the reply after it. A transport that ran
 * each request as work of its own (`Registries.run`) would make it `Admitted`
 * work, waited for above; until one does, a reply slower than `REPLY` is
 * lost, and its client learns the outcome once it reconnects.
 */
export const deferral = (restarts: ReadonlySet<string>, serving: readonly string[]): Effect.Effect<Effect.Effect<void> | undefined> =>
  Effect.map(Admitted, (admitted) => {
    // Outermost first: the first such work ends after everything it runs within it.
    const work = admitted.find((entry) => restarts.has(entry.pluginId));
    const replying = serving.some((id) => restarts.has(id));
    if (work === undefined && !replying) return undefined;
    return Effect.andThen(work?.ended ?? Effect.void, replying ? Effect.sleep(REPLY) : Effect.void);
  });
