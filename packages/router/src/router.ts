import { Order, Result, SchemaRepresentation } from "effect";
import type { Schema } from "effect";
import { BASE, split } from "./history.ts";
import type { HistoryAction, HistoryLocation, RouterHistory } from "./history.ts";
import { compareScores, matchPattern, splitPath } from "./path.ts";
import type { AnyRoute, ParamsOf, SearchOf } from "./route.ts";
import type { Explanation, MatchInfo, RouteInfo, RouterEvent, RouterEventInput, RouterSnapshot, RouteVerdict } from "./inspect.ts";
import { parseSearch } from "./search.ts";

/** Something registered at a route: what shows there, as the embedder defines it. */
export interface RouteEntry {
  readonly route: AnyRoute;
}

interface MatchBase {
  readonly location: HistoryLocation;
  /** Aborted when the location changes again: work started for this match checks it before committing. */
  readonly signal: AbortSignal;
}

/**
 * What the location is: a route with an entry (`matched`), a route known but
 * with nothing registered at it now (`unavailable`: its provider is off, and
 * the page returns with it), or nothing at all (`unmatched`).
 */
export type Match<E extends RouteEntry = RouteEntry> =
  | (MatchBase & { readonly status: "matched"; readonly route: AnyRoute; readonly entry: E; readonly params: unknown; readonly search: unknown })
  | (MatchBase & { readonly status: "unavailable"; readonly route: AnyRoute; readonly params: unknown; readonly search: unknown })
  | (MatchBase & { readonly status: "unmatched" });

export interface NavigateOptions {
  /** Rewrites the current entry instead of adding one. */
  readonly replace?: boolean;
}

export interface Navigate {
  <R extends AnyRoute>(route: R, params: ParamsOf<R>, options?: NavigateOptions & { readonly search?: Partial<SearchOf<R>> }): boolean;
  (href: string, options?: NavigateOptions): boolean;
}

/** `match` narrowed to `route`, matched or unavailable, with its typed params and search. */
export const isRoute = <M extends Match<any>, R extends AnyRoute>(
  match: M,
  route: R,
): match is Extract<M, { readonly route: AnyRoute }> & { readonly route: R; readonly params: ParamsOf<R>; readonly search: SearchOf<R> } =>
  match.status !== "unmatched" && match.route.id === route.id;

/**
 * A navigation about to happen, for blockers. `unload` is the page itself
 * going (closed, reloaded): a blocker refusing it makes the browser ask the
 * user, and one guarding only in-app moves returns true for it.
 */
export interface Transition {
  readonly href: string;
  readonly action: HistoryAction | "unload";
}

export interface RouterOptions {
  readonly history: RouterHistory;
  /** Routes the location may name while nothing is registered at them (they match as `unavailable`). */
  readonly known?: readonly AnyRoute[];
  /** Search keys every navigation keeps from the current location unless it sets them (`safe`, a debug flag). */
  readonly retain?: readonly string[];
  /**
   * Something that failed, and where: a listener or blocker that threw; a
   * navigation to values that do not encode, to a URL rather than a path, or
   * whose history write threw (`navigate`); a back or forward that did not
   * land within `settleTimeout` (`history`). Default `console.error`.
   */
  readonly onError?: (error: unknown, during: "listener" | "blocker" | "navigate" | "history") => void;
  /** Called with each new conflict between routes (see `RouteIssue`), when entries or known routes change. */
  readonly onIssue?: (issue: RouteIssue) => void;
  /** How an entry is named in `inspect`, `explain`, and the journal. Default: its route's id. */
  readonly label?: (entry: any) => string;
  /** How many events the journal keeps; older ones are dropped. Default 200. */
  readonly journal?: number;
  /** How long navigations wait for a back or forward to land before going ahead anyway, the move reported (ms). Default 1000. */
  readonly settleTimeout?: number;
}

export interface BlockOptions {
  /** Who blocks and why (`"editor: unsaved changes"`), for the journal and `inspect`. */
  readonly label?: string;
}

/**
 * Two routes in conflict, which the router resolves the same way every time
 * but the app probably did not mean: two routes with one id (the first
 * registered wins), or two ids matching exactly the same addresses with
 * nothing to tell them apart (the lower id wins). Plugins come and go, so these are reported, not thrown.
 */
export interface RouteIssue {
  readonly kind: "duplicate-id" | "same-addresses";
  readonly routes: readonly AnyRoute[];
  readonly message: string;
}

export interface Router<E extends RouteEntry = RouteEntry> {
  readonly location: () => HistoryLocation;
  readonly match: () => Match<E>;
  /** The current params and search when the location is `route` (matched or unavailable), else undefined. */
  readonly matchOf: <R extends AnyRoute>(route: R) => { readonly params: ParamsOf<R>; readonly search: SearchOf<R> } | undefined;
  /** What `href` would show, without going there (to preload it, or to explain it). */
  readonly matchHref: (href: string) => Match<E>;
  /** Called whenever the match changes: a navigation, or entries coming and going. Returns the unsubscribe. */
  readonly subscribe: (listener: (match: Match<E>) => void) => () => void;
  /** What is registered, in priority order: for a route with several entries, the first is the one shown. */
  readonly setEntries: (entries: readonly E[]) => void;
  readonly setKnown: (routes: readonly AnyRoute[]) => void;
  /** `route`'s address for these values, keeping the retained search keys. Throws when a value does not encode. */
  readonly href: <R extends AnyRoute>(route: R, params: ParamsOf<R>, search?: Partial<SearchOf<R>>) => string;
  /**
   * Goes to `route` with these values, or to `href` (a path in the app, not a
   * URL). Returns false when a blocker refused, or when the values do not
   * encode, `href` is a URL, or the history refuses the write (each reported
   * to `onError`). Made while a `go` is still landing, it waits for it, up to `settleTimeout`.
   */
  readonly navigate: Navigate;
  /** The conflicts between the routes now registered or known. */
  readonly issues: () => readonly RouteIssue[];
  readonly go: (delta: number) => void;
  readonly back: () => void;
  /** Runs before every navigation; returning false stops it (a back or forward is undone). Returns the removal. */
  readonly block: (blocker: (transition: Transition) => boolean, options?: BlockOptions) => () => void;
  /** Why `href` shows what it does: every route's verdict, without going there. */
  readonly explain: (href: string) => Explanation;
  /** The router now, as plain data. */
  readonly inspect: () => RouterSnapshot;
  /** What the router did lately, oldest first. */
  readonly journal: () => readonly RouterEvent[];
  /** Called with each event as it is recorded. Returns the unsubscribe. */
  readonly onEvent: (listener: (event: RouterEvent) => void) => () => void;
  readonly destroy: () => void;
}

type Candidate = { readonly route: AnyRoute; readonly score: readonly number[]; readonly raw: Readonly<Record<string, string>> };

/** Routes ready to match: one per id with its shown entry, and how many segments each can take. */
export interface RouteTable<E extends RouteEntry> {
  readonly entryOf: ReadonlyMap<string, E>;
  readonly routes: readonly { readonly route: AnyRoute; readonly min: number; readonly max: number }[];
}

/** Compiles `entries` (first per route id wins) and `known` routes for `resolve`; done once per change, not per navigation. */
export const compileRoutes = <E extends RouteEntry>(entries: readonly E[], known: readonly AnyRoute[]): RouteTable<E> => {
  const entryOf = new Map<string, E>();
  for (const entry of entries) if (!entryOf.has(entry.route.id)) entryOf.set(entry.route.id, entry);
  const byId = new Map<string, AnyRoute>();
  for (const entry of entryOf.values()) byId.set(entry.route.id, entry.route);
  for (const route of known) if (!byId.has(route.id)) byId.set(route.id, route);
  const routes = [...byId.values()].map((route) => {
    const segments = route.pattern.segments;
    const rest = segments.some((segment) => segment.kind === "rest");
    const min = segments.filter((segment) => segment.kind === "static" || segment.kind === "param").length;
    return { route, min, max: rest ? Infinity : segments.length };
  });
  return { entryOf, routes };
};

const lengthOf = (min: number, max: number) => (max === Infinity ? `${min} or more` : min === max ? `${min}` : `${min} to ${max}`);

/**
 * Matches `location` against a compiled table. Exposed for tests and
 * embedders that keep their own state. With `trace`, every route's verdict is
 * added to it (the chosen route's first), at the cost of trying them all.
 */
export const resolve = <E extends RouteEntry>(location: HistoryLocation, table: RouteTable<E>, signal: AbortSignal, trace?: RouteVerdict[]): Match<E> => {
  const verdict = (route: AnyRoute, outcome: RouteVerdict["outcome"], detail: string) => trace?.push({ route: route.id, path: route.path, outcome, detail });
  const segments = splitPath(location.pathname);
  if (segments === undefined) {
    for (const { route } of table.routes) verdict(route, "no-match", "the path is not valid URL encoding");
    return { status: "unmatched", location, signal };
  }
  const candidates: Candidate[] = [];
  const misses: [AnyRoute, string][] = [];
  for (const { route, min, max } of table.routes) {
    if (segments.length < min || segments.length > max) {
      if (trace !== undefined) misses.push([route, `it takes ${lengthOf(min, max)} segments; the path has ${segments.length}`]);
      continue;
    }
    const found = matchPattern(route.pattern, segments);
    if (found !== undefined) candidates.push({ route, score: found.score, raw: found.params });
    else if (trace !== undefined) misses.push([route, "its literal segments differ from the path's"]);
  }
  // Specificity first; ties by fewer segments, then id, so the answer never depends on the order routes arrived in.
  if (candidates.length > 1) candidates.sort(byPreference);
  const rawSearch = candidates.length === 0 ? {} : parseSearch(location.search);
  let chosen: { readonly match: Match<E>; readonly candidate: Candidate } | undefined;
  for (const candidate of candidates) {
    if (chosen !== undefined) {
      verdict(candidate.route, "outranked", outranked(candidate, chosen.candidate));
      continue;
    }
    // Params that do not decode (an id of the wrong shape) mean this route does not match; the next may.
    const params = candidate.route.decodeParams(candidate.raw);
    if (Result.isFailure(params)) {
      verdict(candidate.route, "rejected", `its params do not decode: ${params.failure}`);
      continue;
    }
    // A search that does not decode falls back to the route's defaults rather than refusing the page.
    const decoded = candidate.route.decodeSearch(rawSearch);
    const search = Result.isSuccess(decoded) ? decoded.success : candidate.route.defaults;
    if (search === undefined) {
      verdict(candidate.route, "rejected", `its search does not decode, and it has no defaults: ${Result.isFailure(decoded) ? decoded.failure : ""}`);
      continue;
    }
    const entry = table.entryOf.get(candidate.route.id);
    const match: Match<E> =
      entry === undefined
        ? { status: "unavailable", route: candidate.route, params: params.success, search, location, signal }
        : { status: "matched", route: candidate.route, entry, params: params.success, search, location, signal };
    if (trace === undefined) return match;
    chosen = { match, candidate };
    const fallback = Result.isFailure(decoded) ? `; its search did not decode (${decoded.failure}), so it uses the defaults` : "";
    verdict(
      candidate.route,
      entry === undefined ? "unavailable" : "shown",
      `${entry === undefined ? "the most specific fit, but nothing is registered at it" : "the most specific fit"}${fallback}`,
    );
  }
  if (trace !== undefined) {
    // The chosen route first, then the near misses, then the rest.
    trace.sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome]);
    for (const [route, detail] of misses) verdict(route, "no-match", detail);
  }
  return chosen?.match ?? { status: "unmatched", location, signal };
};

const ORDER: Readonly<Record<RouteVerdict["outcome"], number>> = { shown: 0, unavailable: 0, outranked: 1, rejected: 2, "no-match": 3 };

/** Why `loser` lost to `winner`, both fitting the path. */
const outranked = (loser: Candidate, winner: Candidate) => {
  const at = loser.score.findIndex((score, index) => score !== winner.score[index]);
  const kinds = ["a rest", "an optional", "a param", "a literal"];
  if (at !== -1 && winner.score[at] !== undefined)
    return `"${winner.route.id}" is more specific: at segment ${at + 1} it has ${kinds[winner.score[at]!]} where this has ${kinds[loser.score[at]!]}`;
  if (loser.score.length !== winner.score.length) return `"${winner.route.id}" fits without a trailing optional or rest`;
  if (loser.route.pattern.segments.length !== winner.route.pattern.segments.length) return `as specific as "${winner.route.id}", which has fewer segments`;
  return `as specific as "${winner.route.id}", which comes first by id`;
};

const byId = Order.mapInput(Order.String, (route: AnyRoute) => route.id);
const byPreference = (a: Candidate, b: Candidate) =>
  compareScores(a.score, b.score) || a.route.pattern.segments.length - b.route.pattern.segments.length || byId(a.route, b.route);

/**
 * Routes nothing tells apart: patterns matching the same paths (literal for
 * literal, the same kind of param at each place) decoded alike (Schemas
 * described the same).
 * Different Schemas are a fallback (`/n/:id` as a number, else as a name).
 */
const sameShape = (a: AnyRoute, b: AnyRoute) =>
  (a.params === b.params || (describe(a.params) ?? a) === (describe(b.params) ?? b)) &&
  a.pattern.segments.length === b.pattern.segments.length &&
  a.pattern.segments.every((segment, index) => {
    const other = b.pattern.segments[index]!;
    return segment.kind === other.kind && (segment.kind !== "static" || (other.kind === "static" && segment.value === other.value));
  });

const descriptions = new WeakMap<Schema.Top, string | undefined>();
/** A Schema's structure as text, once per Schema; undefined (never equal) for one that cannot be described, such as a declared type. */
const describe = (schema: Schema.Top): string | undefined => {
  if (descriptions.has(schema)) return descriptions.get(schema);
  let description: string | undefined;
  try {
    description = JSON.stringify(SchemaRepresentation.toRepresentation(schema.ast));
  } catch {
    description = undefined;
  }
  descriptions.set(schema, description);
  return description;
};

/** The conflicts among `entries` and `known` (see `RouteIssue`). */
export const findIssues = (entries: readonly RouteEntry[], known: readonly AnyRoute[]): RouteIssue[] => {
  const issues: RouteIssue[] = [];
  const firstOf = new Map<string, AnyRoute>();
  const reported = new Set<string>();
  for (const route of [...entries.map((entry) => entry.route), ...known]) {
    const first = firstOf.get(route.id);
    if (first === undefined) firstOf.set(route.id, route);
    else if (first.path !== route.path && !reported.has(`${route.id} ${route.path}`)) {
      reported.add(`${route.id} ${route.path}`);
      issues.push({
        kind: "duplicate-id",
        routes: [first, route],
        message: `Two routes are "${route.id}": ${first.path} (shown) and ${route.path}`,
      });
    }
  }
  const routes = [...firstOf.values()].sort(byId);
  for (const [index, a] of routes.entries()) {
    for (const b of routes.slice(index + 1)) {
      if (sameShape(a, b))
        issues.push({
          kind: "same-addresses",
          routes: [a, b],
          message: `Routes "${a.id}" (${a.path}) and "${b.id}" (${b.path}) match the same addresses; "${a.id}" is shown`,
        });
    }
  }
  return issues;
};

/**
 * Whether `href` is a path in the app (`/x?y#z`, or relative), not a URL
 * naming an origin (`//host/x`, `https://host/x`): the router does not know
 * the page's origin, so any URL's is another.
 */
const isPath = (href: string) => {
  try {
    return new URL(href, BASE).origin === BASE;
  } catch {
    return false;
  }
};

const same = <E extends RouteEntry>(a: Match<E>, b: Match<E>) =>
  a.status === b.status &&
  a.location.key === b.location.key &&
  a.location.href === b.location.href &&
  (a.status === "unmatched" || (b.status !== "unmatched" && a.route === b.route)) &&
  (a.status !== "matched" || (b.status === "matched" && a.entry === b.entry));

export const createRouter = <E extends RouteEntry = RouteEntry>(options: RouterOptions): Router<E> => {
  const { history } = options;
  const retain = options.retain ?? [];
  const onError = options.onError ?? ((error: unknown, during: string) => console.error(`router: a ${during} failed`, error));
  const settleTimeout = options.settleTimeout ?? 1000;
  let entries: readonly E[] = [];
  let known: readonly AnyRoute[] = options.known ?? [];
  let table = compileRoutes(entries, known);
  let issues: readonly RouteIssue[] = [];
  let controller = new AbortController();
  let current: Match<E> = resolve(history.location(), table, controller.signal);
  const listeners = new Set<(match: Match<E>) => void>();
  const blockers = new Map<(transition: Transition) => boolean, string>();
  const label: (entry: E) => string = options.label ?? ((entry) => entry.route.id);

  const kept = options.journal ?? 200;
  let events: RouterEvent[] = [];
  let seq = 0;
  const eventListeners = new Set<(event: RouterEvent) => void>();
  const record = (event: RouterEventInput) => {
    const full = { ...event, seq: ++seq, at: Date.now(), index: history.location().index } as RouterEvent;
    events.push(full);
    if (events.length > kept) events = events.slice(-kept);
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(full);
      } catch {
        // A journal reader that throws hears nothing more of this event; the router goes on.
      }
    }
  };
  const describe = (match: Match<E>): MatchInfo => ({
    status: match.status,
    href: match.location.href,
    ...(match.status === "unmatched" ? {} : { route: match.route.id, params: match.params, search: match.search }),
    ...(match.status === "matched" ? { entry: label(match.entry) } : {}),
  });
  const report = (error: unknown, during: "listener" | "blocker" | "navigate" | "history") => {
    record({ kind: "failed", during, message: error instanceof Error ? error.message : String(error) });
    onError(error, during);
  };

  const update = (moved: boolean) => {
    if (moved) {
      controller.abort();
      controller = new AbortController();
    }
    const next = resolve(history.location(), table, controller.signal);
    if (same(current, next)) return;
    current = next;
    record({ kind: "matched", match: describe(current) });
    // A copy: a listener may unsubscribe while being called. One that throws does not keep the others from hearing.
    for (const listener of Array.from(listeners)) {
      try {
        listener(current);
      } catch (error) {
        report(error, "listener");
      }
    }
  };
  /** Routes changed: compile them again, report new conflicts, and match the location again. */
  const recompile = () => {
    table = compileRoutes(entries, known);
    const before = new Set(issues.map((issue) => issue.message));
    issues = findIssues(entries, known);
    for (const issue of issues) {
      if (before.has(issue.message)) continue;
      record({ kind: "issue", message: issue.message });
      options.onIssue?.(issue);
    }
    update(false);
  };
  // A blocker that throws allows the navigation: a broken one must not trap the user on the page.
  const allowed = (transition: Transition) => {
    for (const [blocker, by] of Array.from(blockers)) {
      let allows = true;
      try {
        allows = blocker(transition);
      } catch (error) {
        report(error, "blocker");
      }
      if (!allows) {
        record({ kind: "blocked", href: transition.href, action: transition.action, by });
        return false;
      }
    }
    return true;
  };

  /**
   * A browser's back or forward lands later (on `popstate`), so a navigation
   * made meanwhile (close, then open something) waits for it: written at
   * once, it would be the entry the move then leaves. Only a move the history
   * says will land is waited for, and only for `settleTimeout`, so the wait
   * always ends: a pop that never comes is reported, and the navigations go ahead.
   */
  let moving = false;
  let waiting: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Where the undo of a refused back or forward lands (the entry it left): the pop landing there is the undo, not a move of its own. */
  let undoing: number | undefined;
  const settle = () => {
    clearTimeout(timer);
    moving = false;
    const run = waiting;
    waiting = [];
    for (const write of run) write();
  };
  const go = (delta: number) => {
    if (delta === 0) return;
    moving = true;
    if (!history.go(delta)) return settle();
    // Its pop came during `go` (a history that moves at once): nothing to wait for.
    if (!moving) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // An undo still expected stays so: if its pop lands late, it is the undo, not a move to refuse again.
      report(new Error(`A move of ${delta} through the history did not land within ${settleTimeout} ms; the router stopped waiting for it`), "history");
      settle();
    }, settleTimeout);
  };

  const stopUnload = history.onUnload?.(() => allowed({ href: history.location().href, action: "unload" }));
  const stop = history.subscribe(({ action, delta, location }) => {
    if (action === "pop" && undoing !== undefined) {
      // The undo lands on an entry the history knows (a new one, from an address edited by hand, has delta 0). Any other
      // pop is a move of its own: the undo's never came, and the router follows the address again.
      const undone = location.index === undoing && delta !== 0;
      undoing = undefined;
      // Matched again, in case navigations went ahead while it landed late.
      if (undone) {
        update(false);
        return settle();
      }
    }
    // A move through the stack has already happened; a blocker that refuses it is answered by moving back, waited for like any `go`.
    if (action === "pop" && delta !== 0 && !allowed({ href: location.href, action })) {
      undoing = location.index - delta;
      go(-delta);
      // Landed already (memory), or never will: there is no pop to tell apart.
      if (!moving) undoing = undefined;
      return;
    }
    if (action === "pop") record({ kind: "moved", href: location.href, delta });
    update(true);
    if (action === "pop") settle();
  });

  /** `href` with the retained search keys the current location has and it does not set. */
  const withRetained = (href: string): string => {
    if (retain.length === 0) return href;
    const url = new URL(href, BASE);
    const now = new URLSearchParams(history.location().search);
    for (const key of retain) {
      const value = now.get(key);
      if (value !== null && !url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  };

  const navigate: Navigate = (to: string | AnyRoute, ...rest: readonly unknown[]): boolean => {
    let href: string;
    let navigateOptions: (NavigateOptions & { readonly search?: unknown }) | undefined;
    if (typeof to === "string") {
      if (!isPath(to)) {
        report(new Error(`Cannot navigate to "${to}": navigate takes a path in the app, not a URL`), "navigate");
        return false;
      }
      href = to;
      navigateOptions = rest[0] as NavigateOptions | undefined;
    } else {
      navigateOptions = rest[1] as (NavigateOptions & { readonly search?: unknown }) | undefined;
      try {
        href = to.href(rest[0], navigateOptions?.search as never);
      } catch (error) {
        report(error, "navigate");
        return false;
      }
    }
    const action = navigateOptions?.replace === true ? "replace" : "push";
    const held = moving;
    const write = () => {
      const target = withRetained(href);
      if (!allowed({ href: target, action })) return false;
      record({ kind: "navigate", href: target, action, held });
      try {
        if (target === history.location().href && action === "push") {
          // The same address again is a replace, so a repeated click adds no entry.
          history.replace(target);
        } else if (action === "replace") history.replace(target);
        else history.push(target);
      } catch (error) {
        // The history refused the write (a browser's limit on how often a page writes, an address it will not take): nothing moved.
        report(error, "navigate");
        return false;
      }
      return true;
    };
    if (!moving) return write();
    waiting.push(write);
    return true;
  };

  const matchOf = <R extends AnyRoute>(route: R) =>
    current.status !== "unmatched" && current.route.id === route.id
      ? { params: current.params as ParamsOf<R>, search: current.search as SearchOf<R> }
      : undefined;

  return {
    location: history.location,
    match: () => current,
    matchOf,
    matchHref: (href) => resolve(split(withRetained(href), "", -1), table, new AbortController().signal),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setEntries: (next) => {
      entries = next;
      recompile();
    },
    setKnown: (next) => {
      known = next;
      recompile();
    },
    issues: () => issues,
    href: (route, params, search) => withRetained(route.href(params, search)),
    navigate,
    go,
    back: () => go(-1),
    block: (blocker, blockOptions) => {
      // A wrapper per call: the same function blocking twice is two blockers, each removed by its own removal.
      const own = (transition: Transition) => blocker(transition);
      blockers.set(own, blockOptions?.label ?? "a blocker without a label");
      return () => void blockers.delete(own);
    },
    explain: (href) => {
      const verdicts: RouteVerdict[] = [];
      const target = withRetained(href);
      const match = resolve(split(target, "", -1), table, new AbortController().signal, verdicts);
      return { href: target, status: match.status, ...(match.status === "unmatched" ? {} : { route: match.route.id }), verdicts };
    },
    inspect: () => {
      const routes = new Map<string, { path: string; known: boolean; entries: string[] }>();
      for (const entry of entries) {
        const found = routes.get(entry.route.id) ?? { path: entry.route.path, known: false, entries: [] };
        found.entries.push(label(entry));
        routes.set(entry.route.id, found);
      }
      for (const route of known) {
        const found = routes.get(route.id);
        if (found === undefined) routes.set(route.id, { path: route.path, known: true, entries: [] });
        else found.known = true;
      }
      return {
        location: history.location(),
        match: describe(current),
        routes: [...routes].map(([id, route]): RouteInfo => ({ id, ...route })).sort((a, b) => Order.String(a.path, b.path)),
        issues: issues.map((issue) => ({ kind: issue.kind, message: issue.message, routes: issue.routes.map((route) => route.id) })),
        blockers: [...blockers.values()],
        retain,
        moving,
      };
    },
    journal: () => events,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    destroy: () => {
      clearTimeout(timer);
      moving = false;
      waiting = [];
      undoing = undefined;
      stopUnload?.();
      stop();
      controller.abort();
      listeners.clear();
      blockers.clear();
      eventListeners.clear();
    },
  };
};
