# @lemma/router-solid

SolidJS bindings for [`@lemma/router`](../router/README.md): its state as
signals, and an outlet that renders the matched page.

```tsx
import { createBrowserHistory, createRouter, interceptLinks } from "@lemma/router";
import { createRouteSignals, RouteOutlet } from "@lemma/router-solid";

const router = createRouter<{ route: AnyRoute; component: Component }>({ history: createBrowserHistory() });
router.setEntries([{ route: User, component: UserPage }]);
interceptLinks(router);
const signals = createRouteSignals(router);

// In UserPage: runs again only when the User route's match changes.
const user = () => signals.matchOf(User)?.params.id;

<RouteOutlet
  match={signals.match}
  unavailable={(match) => <p>{match().route.id} is not available</p>}
  unmatched={(match) => <p>Nothing at {match().location.pathname}</p>}
  failed={(failure) => <button onClick={failure.retry}>Try again</button>}
/>;
```

`createRouteSignals(router)` gives the match and the location as signals, and
`matchOf(route)` a signal per route: what reads one route does not run again
when another is navigated to.

`RouteOutlet` renders the matched entry's `component`. Entries sharing a
component keep one instance across their routes, so moving between them does
not remount it. A page that throws fails alone, inside the outlet: `failed`
shows it (with the entry that failed), and it is tried again on `retry` or
the next navigation.

## Providers

`RouterProvider` hands a router, or one navigator, to the components under it.
Given another navigator, the components follow it, a navigator one kept from
`useNavigator()` too; the signals following the last one stop, as they do when
the provider is removed.
`useMatch(route)`, `useNavigator()`, `useLocation()`, and `useRouteMatch()`
read the nearest one. Each tab or pane provides its own navigator, so a page
component reads its route the same way wherever it is shown:

```tsx
<RouterProvider navigator={tab.navigator}>
  <RouteOutlet match={useRouteMatch<Page>()} />
</RouterProvider>;

// In a page: runs again only when this route's match changes.
const user = useMatch(User);
const navigator = useNavigator(); // navigator.navigate(User, { id }) moves this tab
```

## Keeping views alive

`KeepAlive` shows the active key's view and keeps the most recently active
others mounted but hidden (`display: none`): going back to one keeps its
scroll, inputs, and running work without rendering it again. Past `keep`
(default 5) the least recent is disposed, its cleanups running so it can save
what it needs, and it mounts anew when it returns. With `open`, the keys that
still exist (a tab bar's tabs), a view whose key leaves it is disposed at once,
the active one too, so a closed tab does not linger and an id used again later
mounts a new view.
A view reads `useActive()`, or runs code on `onSuspend` and `onResume`, to
pause work while hidden. When the active key changes, the views that hear it do so in
the order they mounted (Solid runs their effects so), not the one going
hidden first: a view must not count on the other's having paused. `createKeepAlive(active, keep, open)` is the same
choice without the elements, for an embedder drawing its own.

```tsx
<KeepAlive active={activeTab()} open={[...tabs.keys()]} keep={8}>
  {(id) => (
    <RouterProvider navigator={tabs.get(id)!}>
      <RouteOutlet match={useRouteMatch<Page>()} />
    </RouterProvider>
  )}
</KeepAlive>
```
