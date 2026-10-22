/** Where the page is in its history, and the last place known ahead of it. */
export interface Seen {
  readonly index: number;
  readonly top: number;
}

/**
 * `seen` once the page is at `index`, by a push (`pushed`, as the router said: `navigate` with `push`) or another move
 * (back, forward, a replace). A push on to a new entry drops those ahead; any other move keeps them, a forward onto an
 * entry the page never saw included. Before the page has moved, nothing ahead is known (after a reload the browser keeps
 * entries ahead the page cannot see), as the router's history has it.
 */
export const see = (seen: Seen | undefined, index: number, pushed: boolean): Seen =>
  seen === undefined ? { index, top: index } : pushed && index > seen.index ? { index, top: index } : { index, top: Math.max(seen.top, index) };

/** Whether going forward lands on something. */
export const ahead = (seen: Seen): boolean => seen.top > seen.index;
