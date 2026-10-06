import { batch, createSignal } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { AnyRoute, HistoryLocation, Match, Navigator, ParamsOf, RouteEntry, SearchOf } from "@lemma/router";

/** A router's state as Solid signals. */
export interface RouteSignals<E extends RouteEntry> {
  /** What the location shows; changes on every navigation and whenever entries come or go. */
  readonly match: Accessor<Match<E>>;
  /** The location; changes when the address or the history entry does. */
  readonly location: Accessor<HistoryLocation>;
  /** `route`'s params and search while the location is that route, else undefined: what reads it runs again only when that route's match changes. */
  readonly matchOf: <R extends AnyRoute>(route: R) => { readonly params: ParamsOf<R>; readonly search: SearchOf<R> } | undefined;
  /** Stops following the router. */
  readonly dispose: () => void;
}

type Found = { readonly params: unknown; readonly search: unknown; readonly href: string } | undefined;

const foundIn = (match: Match<RouteEntry>, id: string): Found =>
  match.status !== "unmatched" && match.route.id === id ? { params: match.params, search: match.search, href: match.location.href } : undefined;
/** One route's match is the same while the address is: its params and search come from it. */
const sameFound = (a: Found, b: Found) => a === b || (a !== undefined && b !== undefined && a.href === b.href);

/**
 * Follows a router, or any one navigator, with signals. Each route read
 * through `matchOf` gets a signal of its own, so a page reading its route does
 * not run again when another route is navigated to.
 */
export const createRouteSignals = <E extends RouteEntry>(router: Pick<Navigator<E>, "match" | "location" | "subscribe">): RouteSignals<E> => {
  const [match, setMatch] = createSignal(router.match(), { equals: false });
  const [location, setLocation] = createSignal(router.location(), { equals: (a, b) => a.key === b.key && a.href === b.href });
  const routes = new Map<string, readonly [Accessor<Found>, Setter<Found>]>();
  const dispose = router.subscribe((next) =>
    batch(() => {
      setMatch(() => next);
      setLocation(next.location);
      for (const [id, [, set]] of routes) set(foundIn(next, id));
    }),
  );
  const signalOf = (id: string) => {
    let found = routes.get(id);
    if (found === undefined) {
      found = createSignal<Found>(foundIn(router.match(), id), { equals: sameFound });
      routes.set(id, found);
    }
    return found[0];
  };
  return {
    match,
    location,
    matchOf: <R extends AnyRoute>(route: R) => signalOf(route.id)() as { readonly params: ParamsOf<R>; readonly search: SearchOf<R> } | undefined,
    dispose,
  };
};
