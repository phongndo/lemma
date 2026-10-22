/** Where the page is in its history: an entry's place and its key (`HistoryLocation`). */
export interface Entry {
  readonly index: number;
  readonly key: string;
}

/** What the page has seen of its history: each entry's key by its place, where it is, and the last place known ahead. */
export interface Seen {
  readonly keys: ReadonlyMap<number, string>;
  readonly index: number;
  readonly top: number;
}

/**
 * `seen` once the page is at `entry`. A step on to an entry not seen at that place is a new one, which drops those
 * ahead; any other move keeps them. Before the page has moved, nothing ahead is known (after a reload the browser
 * keeps entries ahead the page cannot see), as the router's history has it.
 */
export const see = (seen: Seen | undefined, entry: Entry): Seen => {
  if (seen === undefined) return { keys: new Map([[entry.index, entry.key]]), index: entry.index, top: entry.index };
  const pushed = entry.index === seen.index + 1 && seen.keys.get(entry.index) !== entry.key;
  const keys = new Map([...seen.keys].filter(([index]) => !pushed || index < entry.index));
  keys.set(entry.index, entry.key);
  return { keys, index: entry.index, top: pushed ? entry.index : Math.max(seen.top, seen.index, entry.index) };
};

/** Whether going forward lands on something. */
export const ahead = (seen: Seen): boolean => seen.top > seen.index;
