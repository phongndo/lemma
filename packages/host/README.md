# @lemma/host

The host process. Importing the package runs it (`src/main.ts`): it resolves
paths, reads the config and plugin files into a composition, loads it, and
reloads when they change. [Usage](../../docs/usage.md) describes running it.
Clients that need the host's paths without starting one (the CLI, the desktop
app) import `resolvePaths` from `@lemma/host/paths`.

## Use

```ts
import { resolvePaths } from "@lemma/host/paths";

const paths = resolvePaths({ env: process.env, cwd: process.cwd() });
```

[Configuration](../../docs/configuration.md) describes the files the host
reads, how project rows merge over user rows, project trust, and what happens
to a plugin that cannot run. What runs is planned by
[`@lemma/composition`](../composition/README.md), which the web app plans with
too. The modules' doc comments give their contracts: `loadComposition` never
fails and reports bad files as diagnostics; `patchConfig` and `updateConfig`
edit rows in place, keeping comments, and write the file whole (through a
link, to the file it points to); `compositionInfo`'s id is stable across
processes, because session `request` events record it.

## The host plugin

`hostPlugin` provides `Paths`, `HostControl`, and the host API version. It activates inside `makeLoader`, before the loader value exists, so `main.ts` binds the handle through a `Deferred<Loader>` (see `tests/host-plugin.test.ts`; the handle's `composition` is `compositionInfo(yield* loader.composition, (yield* loader.core.inspect).plugins)`). Two kernel facts shape the rest:

- `Loader.apply` retires the current revision and drains in-flight `core.run` work before swapping. A `HostControl.reload` executed _inside_ `core.run` therefore waits on itself until the dispose deadline. Call it from plugin code (a transport's handler runs in its plugin scope) or, in the app, from the service value captured once with `loader.core.run(HostControl)`.
- A fault raised while a plugin is still staging (activation inside a reload) is published with the pre-swap snapshot; the reload's own `PluginsChanged` follows with the final state. Events are losable by design: the app's log and `core.inspect` remain the source of truth.
