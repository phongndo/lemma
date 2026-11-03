import type { HistoryLocation } from "./history.ts";

/*
 * What the router can say about itself, as plain data (ids, paths, strings;
 * no Schemas or entries), so a devtools panel, a log, or another process can
 * read it alike.
 */

/** Why one route did or did not show an address. */
export interface RouteVerdict {
  readonly route: string;
  readonly path: string;
  /**
   * `shown` or `unavailable`: the route the address names. `outranked`: it
   * fits, but a more specific one won. `rejected`: it fits, but its params do
   * not decode. `no-match`: it does not fit.
   */
  readonly outcome: "shown" | "unavailable" | "outranked" | "rejected" | "no-match";
  readonly detail: string;
}

/** What an address shows, and every route's verdict on it, the chosen one first. */
export interface Explanation {
  readonly href: string;
  readonly status: "matched" | "unavailable" | "unmatched";
  readonly route?: string;
  readonly verdicts: readonly RouteVerdict[];
}

export interface RouteInfo {
  readonly id: string;
  readonly path: string;
  /** Matches while nothing is registered at it (`unavailable`). */
  readonly known: boolean;
  /** What is registered at it, labelled, in priority order: the first is shown, the rest are overridden. */
  readonly entries: readonly string[];
}

export interface MatchInfo {
  readonly status: "matched" | "unavailable" | "unmatched";
  readonly href: string;
  readonly route?: string;
  readonly entry?: string;
  readonly params?: unknown;
  readonly search?: unknown;
}

/** What `inspect` returns: the router now, in ids and strings, so a devtools panel or a log reads it alike. */
export interface RouterSnapshot {
  readonly location: HistoryLocation;
  readonly match: MatchInfo;
  readonly routes: readonly RouteInfo[];
  readonly issues: readonly { readonly kind: string; readonly message: string; readonly routes: readonly string[] }[];
  /** Labels of the blockers asked before each navigation. */
  readonly blockers: readonly string[];
  readonly retain: readonly string[];
  /** A back or forward is landing; navigations made now wait for it. */
  readonly moving: boolean;
}

/** Something the router did, in order: `seq` counts from 1; `index` is the history position at the time. */
export type RouterEvent = { readonly seq: number; readonly at: number; readonly index: number } & (
  | {
      readonly kind: "navigate";
      readonly href: string;
      readonly action: "push" | "replace";
      /** It waited for a back or forward to land. */ readonly held: boolean;
    }
  | { readonly kind: "blocked"; readonly href: string; readonly action: "push" | "replace" | "pop" | "unload"; readonly by: string }
  | { readonly kind: "moved"; readonly href: string; readonly delta: number }
  | { readonly kind: "matched"; readonly match: MatchInfo }
  | { readonly kind: "failed"; readonly during: string; readonly message: string }
  | { readonly kind: "issue"; readonly message: string }
);

/** An event as recorded: the router adds `seq`, `at`, and `index`. */
export type RouterEventInput = RouterEvent extends infer Event ? (Event extends unknown ? Omit<Event, "seq" | "at" | "index"> : never) : never;
