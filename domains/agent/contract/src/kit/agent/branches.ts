import type { KeptBranch } from "../turn.ts";

/**
 * Sessions whose branch, as their last turn left it, the agent keeps for the next turn to start from, the most recently
 * used: a bound on the memory they hold.
 */
export const BRANCHES_KEPT = 16;

/**
 * Each session's branch as its last turn left it, until the next takes it (`of`), the most recently kept last, at most
 * `limit` of them. `sweep`, called every half of the longest a branch may stay unused, lets go of each not kept since
 * the sweep before: one unused for between half of that and all of it.
 */
export const makeKeptBranches = (limit = BRANCHES_KEPT) => {
  /** Each kept branch, and whether it was kept since the last sweep. */
  const branches = new Map<string, { readonly kept: KeptBranch; fresh: boolean }>();
  return {
    /** Where the session's turn takes its branch from, and leaves its own. */
    of: (sessionId: string) => ({
      take: () => {
        const entry = branches.get(sessionId);
        branches.delete(sessionId);
        return entry?.kept;
      },
      keep: (branch: KeptBranch) => {
        branches.delete(sessionId);
        branches.set(sessionId, { kept: branch, fresh: true });
        for (const oldest of branches.keys()) {
          if (branches.size <= limit) break;
          branches.delete(oldest);
        }
      },
    }),
    /** The session's branch goes (it was deleted). */
    drop: (sessionId: string) => void branches.delete(sessionId),
    sweep: () => {
      for (const [sessionId, entry] of branches) {
        if (entry.fresh) entry.fresh = false;
        else branches.delete(sessionId);
      }
    },
  };
};

export type KeptBranches = ReturnType<typeof makeKeptBranches>;
