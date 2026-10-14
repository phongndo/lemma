import { NATIVE_HARNESS } from "@lemma/agent";
import type { Access } from "@lemma/agent";

/**
 * The harness a thread's next turn runs on: the one picked for it in this page, else the one that ran its last turn,
 * else the default for new threads, else Lemma's own loop.
 */
export const effectiveHarness = (picked: string | undefined, last: string | undefined, fallback: string | undefined): string =>
  picked ?? last ?? fallback ?? NATIVE_HARNESS;

/**
 * The access level a thread's next turn asks for: the one picked for it, else the harness's last pick, else
 * supervised, whichever the harness offers; none when it offers none.
 */
export const effectiveAccess = (picked: Access | undefined, saved: Access | undefined, offered: readonly Access[]): Access | undefined =>
  [picked, saved, "supervised" as const].find((level) => level !== undefined && offered.includes(level)) ?? offered[0];
