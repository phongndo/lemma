/**
 * Where the router reads and writes the address: the browser's history, or
 * an in-memory one for tests and embedders. Each entry carries a key (stable
 * for the entry's life, replaces included, for remembering scroll positions and the like) and
 * an index (its position in the stack, so a back or forward can be measured,
 * and undone when something blocks it).
 */
export interface HistoryLocation {
  /** `pathname + search + hash`. */
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly key: string;
  readonly index: number;
}

/** How the location changed: a new entry, the current one rewritten, or a move through the stack (back, forward, an edited address). */
export type HistoryAction = "push" | "replace" | "pop";

export interface HistoryUpdate {
  readonly location: HistoryLocation;
  readonly action: HistoryAction;
  /** For a pop, how far it moved (`-1` for back); 0 when unknown. */
  readonly delta: number;
}

export interface RouterHistory {
  readonly location: () => HistoryLocation;
  /** Adds an entry. Throws, changing nothing, when the history refuses the write (a browser's limit on how often a page writes, another origin). */
  readonly push: (href: string) => void;
  /** Rewrites the current entry, keeping its key. Throws, changing nothing, when the history refuses the write. */
  readonly replace: (href: string) => void;
  /**
   * Moves through the stack. True when the move lands later, with a pop event;
   * false when it already has (memory) or cannot land in this page (past
   * either end of the entries it knows), so nothing should wait for it.
   */
  readonly go: (delta: number) => boolean;
  /** Called after every change, its own pushes and replaces included. Returns the unsubscribe. */
  readonly subscribe: (listener: (update: HistoryUpdate) => void) => () => void;
  /** Asks `allow` before the page unloads (closed, reloaded, left for another site); false asks the user to confirm. Browser only. */
  readonly onUnload?: (allow: () => boolean) => () => void;
  readonly destroy: () => void;
}

let counter = 0;
const newKey = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** What addresses are resolved against: a placeholder origin, since only their path, search, and hash are kept. */
export const BASE = "http://router.invalid";

/** `href` as a location (an address relative to the app's origin), with this key and index. */
export const split = (href: string, key: string, index: number): HistoryLocation => {
  const url = new URL(href, BASE);
  return { href: `${url.pathname}${url.search}${url.hash}`, pathname: url.pathname, search: url.search, hash: url.hash, key, index };
};

const listeners = () => {
  const set = new Set<(update: HistoryUpdate) => void>();
  return {
    subscribe: (listener: (update: HistoryUpdate) => void) => {
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit: (update: HistoryUpdate) => {
      // A copy: a listener may unsubscribe while being called.
      for (const listener of Array.from(set)) listener(update);
    },
    clear: () => set.clear(),
  };
};

interface EntryState {
  readonly key: string;
  readonly index: number;
}
/** Where an entry's key and index live in `history.state`, beside whatever else the page keeps there. */
const STATE = "__router";

const entryState = (state: unknown): EntryState | undefined => {
  const found = (state as Record<string, unknown> | null)?.[STATE] as Partial<EntryState> | undefined;
  return typeof found?.key === "string" && typeof found.index === "number" ? { key: found.key, index: found.index } : undefined;
};

/** The browser's history (`pushState` and `popstate`). Paths are the page's own, so the server must serve the app for every route. */
export const createBrowserHistory = (target: Window = window): RouterHistory => {
  const { history } = target;
  const events = listeners();
  const href = () => `${target.location.pathname}${target.location.search}${target.location.hash}`;
  const write = (method: "pushState" | "replaceState", next: EntryState, url?: string) =>
    history[method]({ ...(history.state as object | null), [STATE]: next }, "", url);

  // An entry reached without our state (the first load, an address edited by hand) is given some.
  const adopt = (index: number): EntryState => {
    const next = { key: newKey(), index };
    try {
      write("replaceState", next);
    } catch {
      // Refused (a browser's limit on how often a page writes): the entry is still followed, its key kept only in memory.
    }
    return next;
  };
  let current = entryState(history.state) ?? adopt(0);
  /**
   * The last entry known ahead: a push drops those after it, a pop may reveal
   * more. After a reload the entries ahead are unknown, so it starts at the
   * current one (a forward then is not waited for; it still lands).
   */
  let top = current.index;

  const onPop = () => {
    const found = entryState(history.state);
    const next = found ?? adopt(current.index + 1);
    const delta = found === undefined ? 0 : next.index - current.index;
    current = next;
    top = found === undefined ? next.index : Math.max(top, next.index);
    events.emit({ location: split(href(), current.key, current.index), action: "pop", delta });
  };
  target.addEventListener("popstate", onPop);

  return {
    location: () => split(href(), current.key, current.index),
    push: (url) => {
      const next = { key: newKey(), index: current.index + 1 };
      // Kept only once the browser takes it: a write it refuses throws, and the entry stays the current one.
      write("pushState", next, url);
      current = next;
      top = current.index;
      events.emit({ location: split(href(), current.key, current.index), action: "push", delta: 1 });
    },
    replace: (url) => {
      write("replaceState", current, url);
      events.emit({ location: split(href(), current.key, current.index), action: "replace", delta: 0 });
    },
    go: (delta) => {
      const target = current.index + delta;
      history.go(delta);
      return delta !== 0 && target >= 0 && target <= top;
    },
    subscribe: events.subscribe,
    onUnload: (allow) => {
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (allow()) return;
        // Both: browsers differ in which one asks the user.
        event.preventDefault();
        event.returnValue = "";
      };
      target.addEventListener("beforeunload", onBeforeUnload);
      return () => target.removeEventListener("beforeunload", onBeforeUnload);
    },
    destroy: () => {
      target.removeEventListener("popstate", onPop);
      events.clear();
    },
  };
};

/** History in memory, starting at `initial` (default `/`). `go` moves at once, as a popstate would. */
export const createMemoryHistory = (initial = "/"): RouterHistory => {
  const events = listeners();
  const entries: HistoryLocation[] = [split(initial, newKey(), 0)];
  let index = 0;
  const at = () => entries[index]!;
  return {
    location: at,
    push: (url) => {
      index++;
      entries.splice(index, entries.length, split(url, newKey(), index));
      events.emit({ location: at(), action: "push", delta: 1 });
    },
    replace: (url) => {
      entries[index] = split(url, at().key, index);
      events.emit({ location: at(), action: "replace", delta: 0 });
    },
    go: (delta) => {
      const next = Math.max(0, Math.min(entries.length - 1, index + delta));
      if (next === index) return false;
      const moved = next - index;
      index = next;
      events.emit({ location: at(), action: "pop", delta: moved });
      // Landed already.
      return false;
    },
    subscribe: events.subscribe,
    destroy: events.clear,
  };
};
