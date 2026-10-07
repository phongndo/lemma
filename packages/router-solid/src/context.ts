import { createComponent, createContext, createMemo, onCleanup, useContext } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { AnyRoute, HistoryLocation, Match, Navigator, ParamsOf, RouteEntry, SearchOf } from "@lemma/router";
import { createRouteSignals } from "./signals.ts";
import type { RouteSignals } from "./signals.ts";

interface Provided {
  readonly navigator: Navigator<any>;
  readonly signals: RouteSignals<any>;
}

const RouterContext = createContext<Accessor<Provided>>();

export interface RouterProviderProps {
  /** The router, or the navigator of this part of the page (a tab, a pane): what the components under it read. */
  readonly navigator: Navigator<any>;
  readonly children?: JSX.Element;
}

/**
 * Hands a navigator, and signals following it, to the components under it:
 * `useMatch`, `useNavigator`, and `useLocation` read the nearest one. Each tab
 * or pane of a page provides its own, so the same page component works in
 * any of them. Given another navigator, the components follow it; the signals
 * following the last one stop, as they do when the provider is removed.
 */
export function RouterProvider(props: RouterProviderProps): JSX.Element {
  const current = createMemo(() => {
    const navigator = props.navigator;
    const signals = createRouteSignals(navigator);
    onCleanup(signals.dispose);
    return { navigator, signals };
  });
  return createComponent(RouterContext.Provider, {
    value: current,
    get children() {
      return props.children;
    },
  });
}

const provided = (reader: string): Accessor<Provided> => {
  const found = useContext(RouterContext);
  if (found === undefined) throw new Error(`${reader} needs a RouterProvider above it`);
  return found;
};

/**
 * The nearest provider's navigator: to navigate, link (`href`), or block. It
 * follows the provider: given another navigator, what a component kept from
 * this (a method it took, too) acts on the new one.
 */
export const useNavigator = <E extends RouteEntry = RouteEntry>(): Navigator<E> => {
  const current = provided("useNavigator");
  /** One function per method, calling the method of whichever navigator is provided when it is called. */
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy({} as Navigator<E>, {
    get: (_, key) => {
      const value: unknown = Reflect.get(current().navigator, key);
      if (typeof value !== "function") return value;
      let method = methods.get(key);
      if (method === undefined) {
        method = (...args) => (Reflect.get(current().navigator, key) as (...args: unknown[]) => unknown)(...args);
        methods.set(key, method);
      }
      return method;
    },
    has: (_, key) => Reflect.has(current().navigator, key),
  });
};

/** `route`'s params and search while the nearest navigator is at it, else undefined; runs again only when that route's match changes. */
export const useMatch = <R extends AnyRoute>(route: R): Accessor<{ readonly params: ParamsOf<R>; readonly search: SearchOf<R> } | undefined> => {
  const current = provided("useMatch");
  return () => current().signals.matchOf(route);
};

/** The nearest navigator's location. */
export const useLocation = (): Accessor<HistoryLocation> => {
  const current = provided("useLocation");
  return () => current().signals.location();
};

/** What the nearest navigator's location shows. */
export const useRouteMatch = <E extends RouteEntry = RouteEntry>(): Accessor<Match<E>> => {
  const current = provided("useRouteMatch");
  return () => current().signals.match() as Match<E>;
};
