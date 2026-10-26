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
