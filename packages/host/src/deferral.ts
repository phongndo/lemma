import { Effect } from "effect";
import { Admitted } from "@lemma/core";

/**
 * When a change that restarts the plugins `restarts` may apply, asked from
 * the work making it: `undefined` for at once, or what to wait for first.
 * What a change restarts is the loader's answer (`Loader.affected`).
 *
 * Applied at once, a change that restarts a plugin whose work is making it
 * would wait on that work, or cut it off. Work run with a plugin's items
 * (`Admitted`, as a channel call it serves is) holds that plugin's disposal,
 * which would wait on the change waiting on it until the dispose deadline:
 * the change waits for the work to end instead. The transport serving the
 * request is such a plugin too: it runs each request as its work until the
 * reply has left its connection, which only it can tell, so a change
 * restarting it applies once the client has its answer.
 */
export const deferral = (restarts: ReadonlySet<string>): Effect.Effect<Effect.Effect<void> | undefined> =>
  Effect.map(Admitted, (admitted) => {
    // Outermost first: the first such work ends after everything it runs within it.
    const work = admitted.find((entry) => restarts.has(entry.pluginId));
    return work?.ended;
  });
