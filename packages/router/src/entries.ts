/** Where an `EntryStore` keeps its state between page loads: `sessionStorage`, or anything shaped like it. */
export interface KeyValueStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface EntryStoreOptions {
  /** Where the state is kept between page loads (`sessionStorage`, so each browser tab has its own). Absent: in memory only. */
  readonly storage?: KeyValueStorage | undefined;
  /** The storage key it is kept under. Default `"router.entries"`. */
  readonly key?: string;
  /** How many history entries keep state; past that, those written least recently are dropped. Default 100. */
  readonly limit?: number;
  /** A listener that threw. Default `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/**
 * State kept with history entries, by entry key (`HistoryLocation.key`) and
 * name: a scroll position, a draft, an expanded row. Going back or forward to
 * an entry finds its state again, and with `storage`, so does a reload.
 */
export interface EntryStore {
  readonly get: <T>(entry: string, name: string) => T | undefined;
  /** Keeps `value` (it must be JSON to outlive the page); the entry becomes the most recently written. */
  readonly set: (entry: string, name: string, value: unknown) => void;
  /** Every entry's state, by entry key. */
  readonly all: () => Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Called after every change. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One entry's state: its own names only, so nothing inherited (`constructor`) reads as state. */
const own = (state: Record<string, unknown>): Record<string, unknown> => Object.assign(Object.create(null) as Record<string, unknown>, state);

/**
 * The state as stored: entries in the order they were written (a list, since an object would put keys that look like
 * numbers first), each value that JSON can hold. One that it cannot (a cycle, a BigInt) stays in memory only, as do
 * those in `unsaved`.
 */
const serialize = (states: ReadonlyMap<string, Record<string, unknown>>, unsaved: ReadonlyMap<string, ReadonlySet<string>>): string => {
  const entries: string[] = [];
  for (const [entry, state] of states) {
    const fields: string[] = [];
    const skipped = unsaved.get(entry);
    for (const name of Object.keys(state)) {
      if (skipped?.has(name) === true) continue;
      try {
        const json = JSON.stringify(state[name]);
        if (json !== undefined) fields.push(`${JSON.stringify(name)}:${json}`);
      } catch {
        // Not JSON: kept for as long as the page lasts.
      }
    }
    entries.push(`[${JSON.stringify(entry)},{${fields.join(",")}}]`);
  }
  return `[${entries.join(",")}]`;
};

/** What `storage` held, as far as it can be trusted: state by entry, in the order written (an older object form too). */
const deserialize = (text: string): Map<string, Record<string, unknown>> => {
  const states = new Map<string, Record<string, unknown>>();
  const saved: unknown = JSON.parse(text);
  const pairs: readonly unknown[] = Array.isArray(saved) ? saved : isRecord(saved) ? Object.entries(saved) : [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !isRecord(pair[1])) continue;
    states.set(pair[0], own(pair[1]));
  }
  return states;
};

/**
 * An `EntryStore`, read from `storage` when it has one. What it read is
 * checked rather than trusted: anything that is not state by entry is dropped,
 * and so are entries past `limit`, oldest first. A value the storage refuses
 * (too big for what is left of it) is kept for as long as the page lasts, as
 * is a value JSON cannot hold, without keeping the rest from being saved; a
 * storage that refuses everything (turned off) leaves all of it in memory.
 */
export const createEntryStore = (options: EntryStoreOptions = {}): EntryStore => {
  const key = options.key ?? "router.entries";
  const limit = options.limit !== undefined && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 100;
  const onError = options.onError ?? ((error: unknown) => console.error("router: an entry store listener failed", error));
  const listeners = new Set<() => void>();
  let states = new Map<string, Record<string, unknown>>();
  try {
    states = deserialize(options.storage?.getItem(key) ?? "[]");
  } catch {
    // Unreadable or not JSON: start empty.
  }
  /** Values the storage refused, by entry: kept in memory, left out of what is saved so the rest still is. */
  const unsaved = new Map<string, Set<string>>();
  /** Drops the entries written least recently while there are more than `limit`. */
  const trim = () => {
    for (const old of states.keys()) {
      if (states.size <= limit) break;
      states.delete(old);
      unsaved.delete(old);
    }
  };
  trim();
  /** Saves the state; if the storage refuses it, saves it without what was just written. */
  const save = (entry: string, name: string) => {
    const storage = options.storage;
    if (storage === undefined) return;
    try {
      storage.setItem(key, serialize(states, unsaved));
      return;
    } catch {
      // Likely the value just written does not fit: keep it in memory only, and save the rest.
    }
    let skipped = unsaved.get(entry);
    if (skipped === undefined) unsaved.set(entry, (skipped = new Set()));
    skipped.add(name);
    try {
      storage.setItem(key, serialize(states, unsaved));
    } catch {
      // Storage full or off: the state lasts as long as the page.
    }
  };
  let view: Record<string, Readonly<Record<string, unknown>>> | undefined;
  return {
    get: <T>(entry: string, name: string) => {
      const state = states.get(entry);
      return state !== undefined && Object.hasOwn(state, name) ? (state[name] as T) : undefined;
    },
    set: (entry, name, value) => {
      const state = own({ ...states.get(entry) });
      state[name] = value;
      // The entry written last moves to the end, so the oldest are the first dropped.
      states.delete(entry);
      states.set(entry, state);
      // A new value may fit where the last did not.
      unsaved.get(entry)?.delete(name);
      trim();
      view = undefined;
      save(entry, name);
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          onError(error);
        }
      }
    },
    all: () => (view ??= Object.fromEntries(states)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};
