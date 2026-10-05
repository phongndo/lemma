import { createEffect, createSignal } from "solid-js";
import { createBrowserHistory, createRouter, interceptLinks } from "@lemma/router";
import { createRouteSignals } from "@lemma/router-solid";
import { KnownRoutes, Notify, Pages, Router, Slots, UiPlugins } from "../ui/contracts.ts";
import type { Page } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem } from "../ui/slots.ts";

/** Search keys every navigation keeps: they say how the page runs, not what it shows. */
const RETAIN = ["safe", "mock"];
/** Paths the host serves itself, which a link may name without being a page. */
const HOST_PATHS = /^\/(api|rpc)(\/|$)/;
const ENTRIES_KEY = "lemma.router.entries";
/** History entries whose state is kept; older ones are dropped. */
const ENTRIES_KEPT = 100;

type EntryStates = Record<string, Record<string, unknown>>;
const loadEntries = (): EntryStates => {
  try {
    return JSON.parse(sessionStorage.getItem(ENTRIES_KEY) ?? "{}") as EntryStates;
  } catch {
    return {};
  }
};

/** What a failure the router reports is, for its toast. */
const FAILED: Readonly<Record<string, string>> = {
  navigate: "Could not go there",
  history: "The browser did not finish going back or forward",
  listener: "A route listener failed",
  blocker: "A route blocker failed",
};

/**
 * The page's address as state: the history, which route it names, and which
 * `Pages` item shows there. The app's routes, and those every known plugin
 * declares, match while nothing shows them, so a page whose plugin is off says
 * so. Plain clicks on links to the app's own pages navigate in place, so any
 * plugin links with an ordinary `<a href>`, and hovering one preloads its page.
 */
export default defineUiPlugin({
  id: "router",
  requires: { slots: Slots, notify: Notify, plugins: UiPlugins },
  provides: { router: Router },
  setup: ({ slots, notify, plugins }, plugin) => {
    const history = createBrowserHistory();
    const router = createRouter<SlotItem<Page>>({
      history,
      known: KnownRoutes,
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
    plugin.onCleanup(router.destroy);
    plugin.onCleanup(history.destroy);
    const signals = createRouteSignals(router);
    plugin.onCleanup(signals.dispose);
    const [journal, setJournal] = createSignal(router.journal(), { equals: false });
    plugin.onCleanup(router.onEvent(() => setJournal(router.journal())));
    // Pages come and go with their plugins; the location is matched again each time.
    createEffect(() => router.setEntries(slots.list(Pages)));
    // Plugins come and go from the composition too: a route is known while any known plugin declares it.
    createEffect(() => router.setKnown([...KnownRoutes, ...plugins.routes().map((declared) => declared.route)]));

    // Links to pages navigate in place; hovering or focusing one warms what it shows (its page's `preload`).
    plugin.onCleanup(
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

    const [entryStates, setEntryStates] = createSignal<EntryStates>(loadEntries());
    let entries = entryStates();
    const entry = <T>(name: string) => {
      const key = signals.location().key;
      return {
        get: () => entries[key]?.[name] as T | undefined,
        set: (value: T) => {
          const { [key]: current, ...rest } = entries;
          // The entry written last moves to the end, so the oldest are the first dropped.
          entries = { ...rest, [key]: { ...current, [name]: value } };
          const keys = Object.keys(entries);
          if (keys.length > ENTRIES_KEPT) for (const old of keys.slice(0, keys.length - ENTRIES_KEPT)) delete entries[old];
          setEntryStates(entries);
          try {
            sessionStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
          } catch {
            // Storage full or off: the state lasts as long as the page.
          }
        },
      };
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
    };
  },
});
