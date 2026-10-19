import { createHash } from "node:crypto";
import { deriveMessages, rebuildRequest } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";

/**
 * What the session format's fixture corpus is checked against (`domains/sessions/files/tests/fixtures`): how every
 * reader projects a session's events. A change that would read an old session differently changes a digest.
 */
export interface Projection {
  /** Per leaf of the session's tree, the digest of its branch's model history (`deriveMessages`). */
  readonly leaves: Readonly<Record<string, string>>;
  /** Per `request` event, the digest of the request rebuilt from the log (`rebuildRequest`). */
  readonly requests: Readonly<Record<string, string>>;
}

/** The ids of the events nothing follows: one per branch of the tree. */
export const leavesOf = (events: readonly SessionEvent[]): string[] => {
  const parents = new Set(events.flatMap((event) => (event.parent === null ? [] : [event.parent])));
  return events.filter((event) => !parents.has(event.id)).map((event) => event.id);
};

const branchTo = (events: readonly SessionEvent[], leaf: string): SessionEvent[] => {
  const byId = new Map(events.map((event) => [event.id, event]));
  const path: SessionEvent[] = [];
  for (let at = byId.get(leaf); at !== undefined; at = at.parent === null ? undefined : byId.get(at.parent)) path.push(at);
  return path.reverse();
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** The projection of one session's events, as the readers derive it now. */
export function projectionOf(events: readonly SessionEvent[]): Projection {
  const leaves: Record<string, string> = {};
  const requests: Record<string, string> = {};
  for (const leaf of leavesOf(events)) {
    const branch = branchTo(events, leaf);
    leaves[leaf] = digest(deriveMessages(branch));
    for (const event of branch) {
      if (event.data.type !== "request" || requests[event.id] !== undefined) continue;
      const request = rebuildRequest(branch, event.id);
      requests[event.id] = digest(request === undefined ? null : { ...request });
    }
  }
  return { leaves, requests };
}
