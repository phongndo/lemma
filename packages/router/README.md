# @lemma/router

A client-side router for apps whose pages come and go at runtime: plugins
loaded, replaced, and unloaded while the app runs. Routes are values, typed by
their own definitions rather than by a tree known at build time, and what shows
at a route is registered separately, so a link to a route works while nothing
shows it. Its only dependency is Effect (Schema decodes and encodes params and
search).

```ts
import { createBrowserHistory, createRouter, defineRoute, isRoute } from "@lemma/router";

// Params come from the path: { id: string; tab?: string }. Search from its defaults: { page: number }.
const User = defineRoute("user", { path: "/users/:id/:tab?", search: { page: 1 } });

const router = createRouter<{ route: typeof User; render: () => string }>({ history: createBrowserHistory(), known: [User], retain: ["debug"] });
router.setEntries([{ route: User, render: () => "…" }]); // whenever what is registered changes
router.subscribe((match) => draw(match));
router.navigate(User, { id: "ada" }, { search: { page: 2 } }); // "/users/ada?page=2"
router.href(User, { id: "ada" }); // "/users/ada", for links
router.matchOf(User); // { params: { id: "ada" }, search: { page: 2 } }
const match = router.match();
if (isRoute(match, User)) match.params.id; // narrowed: typed params and search
```

## Routes

`defineRoute(id, { path, params?, search? })` makes a route. The id names it
for registration and overrides; the path is `/literal/:param/:optional?/*rest`
(optional segments only at the end, a rest last). Without Schemas, params are
the path's names as strings, typed from the path itself, and the route takes
no search. Params and search Schemas decode the URL's strings into typed
values and encode them back; search keys equal to their defaults are left out
of the URL, and undeclared ones are ignored.

A search can be described by its defaults instead: `search: { page: 1, tab:
"all", open: false }` reads each key as its default's type (a string, a finite
number, or `true`/`false`), decoding to the default when absent
(`searchSchema` makes the Schema). Write the Schema for anything else (an
optional key, a list, a union of literals). Effect Schema stays underneath
because the router encodes as well as decodes: `href` and `navigate` write typed
values back into a URL.

A mistake in a definition is caught where it is made: a params Schema whose
fields are not the path's names, or a Schema that does not read strings
(`Schema.Number` rather than `Schema.NumberFromString`), is a compile error;
a bad path, or a mismatch the types could not see, throws a `RouteError`
naming the route.

## Tables and navigators

`createRouter` is a route table and one navigator over it, which is what a page
with one location needs. A page with several (tabs, split panes, a preview)
makes them separately. `createRouteTable({ known, onIssue, label })` holds the
routes and what is registered at them, compiled once per change. Each
`createNavigator(table, { history, retain, onError, journal, settleTimeout })`
has its own history, match, blockers, and journal:

```ts
const table = createRouteTable<Page>({ known });
table.setEntries(pages); // compiled once, for every navigator
const tabs = new Map(saved.map((tab) => [tab.id, createNavigator(table, { history: createMemoryHistory(tab.href) })]));
tabs.get("a")!.navigate(User, { id: "ada" }); // moves that tab only
```

When the table changes, each navigator matches its own location again (about
a resolve's cost each) and journals the new conflicts. A navigator costs a few
microseconds to make and a few kilobytes when made (`bench/budgets.ts` holds
the numbers); what it holds then grows with its history's entries and its
journal (up to twice `journal` events between trims; `journal: 0` keeps none),
so a page with many navigators sets a small journal. Destroying one stops it
following its history and table. Destroying the table leaves its navigators
the routes they last had: later `setEntries` and `setKnown` change nothing.
Everything below applies to each navigator alike; `Router` is a `Navigator`
with the table's `setEntries`, `setKnown`, and `issues`.

## Matching

`setEntries(entries)` says what is registered, in priority order: for a route
with several entries, the first is the one shown, so an override comes before
the default and the default returns when the override leaves. Each call
matches the location again, without a navigation. `known` routes match while
nothing is registered at them.

The location matches the most specific route, never the first registered:
segment by segment, a literal beats a param beats a filled optional beats a
rest, earlier segments counting most; an exact match beats a rest that matches
nothing; ties go to fewer segments, then the lower id. Params that fail their
Schema skip the route (the next may match); a search that fails falls back to
the route's defaults. The match is one of:

- `matched`: a route and the entry shown there, with typed params and search;
- `unavailable`: a known route with nothing registered (its provider is off;
  the page returns, at the same address, when an entry does);
- `unmatched`: no route.

Every match carries the location and an `AbortSignal` aborted by the next
navigation, so work started for a page can check it before committing.
`isRoute(match, route)` narrows a match to a route's typed params and search.

Entries are compiled into a table when they change, not on each navigation.
Routes are indexed by their first segment when it is literal, so a path is
tried only against the routes that could fit it, whatever the number of
routes; those that cannot fit the path's length are skipped too.

## Conflicts and errors

Routes come and go with whoever registers them, so a conflict is reported, not
thrown, and the router still picks one: `onIssue` hears each new one and
`issues()` lists those now. Two routes with one id (the first registered is
shown), or two matching exactly the same addresses with Schemas that read them
alike (the lower id is shown), are conflicts; routes whose Schemas tell them
apart are a fallback. Schemas read alike when their structure is the same and
they run the same checks and transformations, compared by identity. Two built
apart from the same parts (`Schema.FiniteFromString`) read alike; a check written
twice reads as two, which can miss a conflict but never invents one.

A listener or blocker that throws is reported to `onError` (default
`console.error`) and does not stop the others; a throwing blocker allows the
navigation, so a broken one cannot trap the user. `navigate` to values that do
not encode reports the `RouteError` and returns false; `href` throws it.
`navigate` also refuses a URL rather than a path in the app (`//host/x`,
`https://host/x`: the router does not know the page's origin, so any is
another), and a history write that throws (Safari limits how often a page
writes) leaves the location as it was; both are reported and return false.

## Inspection

`explain(href)` says what an address shows and why: every route's verdict on
it (`shown` or `unavailable`, `outranked` by a more specific route, `rejected`
because its params do not decode, or `no-match`), with the reason, matched by
the same code as navigation. `inspect()` is the router now: every route with
what is registered at it in priority order, conflicts, blockers by label
(`block(blocker, { label })`), and the retained keys. `journal()` keeps the
latest events (navigations, matches, backs and forwards, refusals, failures,
conflicts) and `onEvent` hears each. All of it is plain data (ids and strings,
entries named by the `label` option), so a devtools panel, a log, or another
process reads it alike.

## Links

`interceptLinks(router, { ignore, onIntent })` makes plain clicks on links to
the app's own pages navigate in place, so any code links with an ordinary
`<a href>`. Modified clicks (a new tab), downloads, other targets and origins,
`rel="external"`, fragments of the same page, and paths `ignore` names are left
to the browser. Resting the pointer on such a link (50 ms) or focusing it calls
`onIntent(href)`; `router.matchHref(href)` says what it would show, without
going there, so its page can preload.

## History

`createBrowserHistory()` uses `pushState` and `popstate` (the server must serve
the app at every route's path); `createMemoryHistory(initial)` is for tests and
embedders. Each entry has a `key` (kept across replaces, for state such as a
scroll position) and an `index`, so a back or forward can be measured and
undone: `block(blocker)` runs before every navigation and stops it, rolling a
back or forward back. It also runs, with `action: "unload"`, before the page
itself unloads (closed or reloaded), where refusing has the browser ask the
user; a blocker guarding only in-app moves returns true for it. A browser's
back or forward (a refused one's undo too) lands later, so a `navigate` made
while one is landing waits for it rather than being the entry it leaves, for
`settleTimeout` at most (default 1000 ms): a move that has not landed by then
is reported (during `history`) and the navigations go ahead; a refused
move's undo that lands later is still taken as the undo. `retain` lists
search keys every navigation keeps from the current location unless it sets
them.

## Saving and restoring

A memory history's `snapshot()` is its stack as data: each entry's address and
key, and which is current. `createMemoryHistory(snapshot)` restores it, keys
included, so a tab's back and forward survive a reload or a crash. Save it as
the history changes (`history.subscribe`). A snapshot is read rather than
trusted: an entry that is not a path in the app (not a string, or a URL naming
another origin) is dropped, a repeated key is replaced, and the index still
names the saved current entry (the last one kept before it, when it was the
one dropped).

`createEntryStore({ storage, key, limit })` keeps state with history entries,
by entry key and name: a scroll position, a draft. Going back to an entry
finds its state again, and with `storage` (`sessionStorage`, anything with
`getItem` and `setItem`) so does a reload. Past `limit` (default 100) the
entries written least recently are dropped. What it reads is checked, and only
what was stored is read back (no inherited names). A write the storage refuses
(full, turned off) keeps the state for as long as the page lasts; a value JSON
cannot hold (a cycle, a BigInt) stays in memory without keeping the rest from
being saved. A listener that throws is reported to `onError` (default
`console.error`) and does not keep the others from hearing.

## Not here

No data loading, preloading, or rendering: the embedder decides what an entry
is and draws the match. No hash history, nested layouts, or route masking.

## Develop

From the repository root:

```sh
nix develop -c pnpm --filter @lemma/router test           # behavior, types, and the benchmarks at tiny counts
nix develop -c pnpm router:bench                          # warm microbenchmarks against bench/budgets.ts
nix develop -c node packages/router/scripts/check-package.ts             # the packed package in a separate Node consumer
nix develop .#browser -c node packages/router/scripts/check-package.ts --browser   # and in Chromium, with its bundle size
```

The package depends on Effect alone (for Schema), imports nothing else from
this repository, and its docs link only within it, so it can leave as it is.
`pnpm pack` builds `dist` and packs it; `publishConfig.exports` leaves the
repository's `lemma-source` condition out of the packed manifest.

[`bench/budgets.ts`](bench/budgets.ts) records each benchmark's budget and the
reference machine. Timing budgets are advisory unless `LEMMA_PERF_ENFORCE=1`
(measure on an idle, comparable machine); the browser bundle's size budget
always fails when exceeded.
