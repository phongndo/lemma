import { Effect } from "effect";
import type { Context } from "effect";
import type { SessionEvent, Sessions } from "@lemma/contracts";
import { failedAs } from "./turn.ts";

/**
 * Each session's request ids that are in its log, with the turn that placed
 * them: read from the log once (`load`), then kept as turns log prompts, so a
 * prompt's exactly-once check does not reread it while the session is busy.
 * Dropped when the session goes idle, so a long-running host keeps none for
 * idle sessions.
 */
export const makeRequestIndex = (sessions: Context.Service.Shape<typeof Sessions>) => {
  const placed = new Map<string, Map<string, string | undefined>>();
  const loaded = new Set<string>();
  /** The session's request ids, each with the turn that placed it. */
  const of = (sessionId: string) => {
    let known = placed.get(sessionId);
    if (known === undefined) {
      known = new Map();
      placed.set(sessionId, known);
    }
    return known;
  };
  /** Adds the requests `log` places, and counts the session as read. */
  const index = (sessionId: string, log: readonly SessionEvent[]) => {
    const known = of(sessionId);
    for (const event of log) {
      if (event.data.type === "message" && event.data.message.role === "user" && event.data.requestId !== undefined && !known.has(event.data.requestId)) {
        known.set(event.data.requestId, event.data.turnId);
      }
    }
    loaded.add(sessionId);
  };
  /** Reads the session's log once. A session not created yet has no requests; a log that cannot be read fails the check rather than pass it. */
  const load = (sessionId: string) =>
    Effect.suspend(() =>
      loaded.has(sessionId)
        ? Effect.void
        : sessions.events(sessionId).pipe(
            Effect.catchIf(
              (error) => error.reason === "NotFound",
              () => Effect.succeed([]),
            ),
            Effect.mapError(failedAs(sessionId, "Session")),
            Effect.map((log) => index(sessionId, log)),
          ),
    );
  /** Forgets the session. */
  const drop = (sessionId: string) => {
    placed.delete(sessionId);
    loaded.delete(sessionId);
  };
  return { of, index, load, drop };
};
