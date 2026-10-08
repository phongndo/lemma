import { createEffect, createRoot, createSignal } from "solid-js";
import { createBrowserHistory, createEntryStore, createRouter, interceptLinks } from "@lemma/router";
import type { AnyRoute, KeyValueStorage } from "@lemma/router";
import { createRouteSignals } from "@lemma/router-solid";
import { Pages } from "../ui/runtime.ts";
import type { NotifyService, Page, RouterService, UiPluginsService } from "../ui/runtime.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";

/** Search keys every navigation keeps: they say how the page runs, not what it shows. */
const RETAIN = ["safe", "mock"];
/** Paths the host serves itself, which a link may name without being a page. */
const HOST_PATHS = /^\/(api|rpc)(\/|$)/;
const ENTRIES_KEY = "lemma.router.entries";
/** History entries whose state is kept; older ones are dropped. */
const ENTRIES_KEPT = 100;

/** The page's session storage, where it may use it (a browser can turn it off, which makes reading it throw). */
const sessionStore = (): KeyValueStorage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** What a failure the router reports is, for its toast. */
const FAILED: Readonly<Record<string, string>> = {
  navigate: "Could not go there",
  history: "The browser did not finish going back or forward",
  listener: "A route listener failed",
  blocker: "A route blocker failed",
};

/** Made with `defineRoute`: what the router can match. A plugin's item or declaration may hold anything. */
const isRoute = (value: unknown): value is AnyRoute =>
  typeof value === "object" && value !== null && typeof (value as Partial<AnyRoute>).id === "string" && (value as Partial<AnyRoute>).pattern !== undefined;

/**
 * The runtime's `Router` over this core's slots: the page's history, which
 * route it names, and which `Pages` item shows there. It knows `known` (the
 * app's own routes) and the routes every known plugin declares, which match
 * while nothing shows them, so a page whose plugin is off says so. It reads
 * plugins' pages only reactively: with none, every address is unmatched or
 * unavailable. A `Pages` item that is no page is blamed on the plugin that
 * added it, and its own failures are logged and reported, so routing goes on.
 * `dispose` releases the history, the link handler, and its effects.
 */
export function createRouterService(options: {
  readonly slots: SlotsService;
  readonly notify: NotifyService;
  readonly plugins: UiPluginsService;
  readonly known: readonly AnyRoute[];
}): { readonly router: RouterService; readonly dispose: () => void } {
  const { slots, notify, plugins, known } = options;
  const failed = (what: string, error: unknown) => {
    console.error(`lemma router: ${what} failed`, error);
    notify.report(error, `The router could not ${what}`);
  };
  const history = createBrowserHistory();
  const router = createRouter<SlotItem<Page>>({
    history,
    known,
    retain: RETAIN,
    // A page is named by its `Pages` item id; the devtools find its plugin from that.
    label: (page: SlotItem<Page>) => page.id,
    onError: (error, during) => notify.report(error, FAILED[during] ?? `A route ${during} failed`),
    // Plugins' routes in conflict: the app still shows one, but which is probably not what either plugin meant.
    onIssue: (issue) => {
      console.warn(`lemma router: ${issue.message}`);
      const owners = issue.routes.flatMap((route) => {
        const page = slots.list(Pages).find((item) => item.route === route);
        return page === undefined ? [] : [slots.owner(Pages, page.id)];
      });
      notify.toast({ level: "warning", ...(owners[0] === undefined ? {} : { source: owners[0] }), message: issue.message });
    },
  });
  const releases: (() => void)[] = [router.destroy, history.destroy];
  return createRoot((disposeRoot) => {
    const signals = createRouteSignals(router);
    releases.push(signals.dispose);
    const [journal, setJournal] = createSignal(router.journal(), { equals: false });
    releases.push(router.onEvent(() => setJournal(router.journal())));
    // Pages come and go with their plugins; the location is matched again each time.
    createEffect(() => {
      const pages = slots.list(Pages);
      const malformed = pages.filter((page) => !isRoute(page.route));
      // Its plugin's fault: the item leaves the slot, and this runs again without it.
      for (const page of malformed) slots.fail(Pages, page, new Error(`The "${page.id}" page has no route made with defineRoute`));
      if (malformed.length > 0) return;
      try {
        router.setEntries(pages);
      } catch (error) {
        failed("take in the pages", error);
      }
    });
    // Plugins come and go from the composition too: a route is known while any known plugin declares it.
    createEffect(() => {
      const declared = plugins.routes().filter(({ route, pluginId }) => {
        if (isRoute(route)) return true;
        console.warn(`lemma router: "${pluginId}" declares a route not made with defineRoute; it is left out`);
        return false;
      });
      try {
        router.setKnown([...known, ...declared.map(({ route }) => route)]);
      } catch (error) {
        failed("take in the declared routes", error);
      }
    });

    // Links to pages navigate in place; hovering or focusing one warms what it shows (its page's `preload`).
    releases.push(
      interceptLinks(router, {
        ignore: (url) => HOST_PATHS.test(url.pathname),
        onIntent: (href) => {
          const target = router.matchHref(href);
          if (target.status !== "matched" || target.entry.preload === undefined) return;
          try {
            target.entry.preload(target);
          } catch (error) {
            console.warn(`lemma router: preloading ${href} failed`, error);
          }
        },
      }),
    );

    // State kept with history entries (a scroll position), back with the entry on back, forward, and reload.
    const store = createEntryStore({ storage: sessionStore(), key: ENTRIES_KEY, limit: ENTRIES_KEPT });
    const [entryStates, setEntryStates] = createSignal(store.all());
    releases.push(store.subscribe(() => setEntryStates(store.all())));
    const entry = <T>(name: string) => {
      const key = signals.location().key;
      return { get: () => store.get<T>(key, name), set: (value: T) => store.set(key, name, value) };
    };

    return {
      router: {
        location: signals.location,
        match: signals.match,
        matchHref: router.matchHref,
        matchOf: signals.matchOf,
        href: router.href,
        navigate: router.navigate,
        back: router.back,
        go: router.go,
        block: router.block,
        entry,
        explain: router.explain,
        // Pages coming and going change it without an event; reading both keeps it current.
        inspect: () => (journal(), slots.list(Pages), router.inspect()),
        journal,
        entryStates,
      },
      dispose: () => {
        disposeRoot();
        for (const release of releases.reverse()) release();
      },
    };
  });
}
