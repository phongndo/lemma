# @lemma/plugin-host

Provides `Paths` and `HostControl`, publishes `PluginsChanged`, and exports the functions `packages/host` runs before any plugin exists: resolving paths, reading and merging `config.jsonc` files into a `Composition`, watching them, and describing the running composition.

## Use

```ts
import { compositionInfo, hostPlugin, loadComposition, resolvePaths, watchConfig } from "@lemma/plugin-host";

const paths = resolvePaths({ env: process.env, cwd: process.cwd() });
const { composition, diagnostics, files } = await Effect.runPromise(loadComposition(paths));
```

[Configuration](../../docs/configuration.md) describes the files these read,
how project rows merge over user rows, and project trust. Each export's doc
comment gives its contract: `loadComposition` never fails and reports bad
files as diagnostics; `patchConfig` and `updateConfig` edit rows in place,
keeping comments; `resolveComposition` and `withReplacements` decide what
turning a plugin on or off does to the plugins around it; `compositionInfo`'s
id is stable across processes, because session `request` events record it.

## Wiring in the app

The plugin activates inside `makeLoader`, before the loader value exists, so the app binds the handle through a `Deferred<Loader>` (see `tests/plugin.test.ts`; the handle's `composition` is `compositionInfo(yield* loader.composition, (yield* loader.core.inspect).plugins)`). Two kernel facts shape the rest:

- `Loader.apply` retires the current revision and drains in-flight `core.run` work before swapping. A `HostControl.reload` executed _inside_ `core.run` therefore waits on itself until the dispose deadline. Call it from plugin code (a transport's handler runs in its plugin scope) or, in the app, from the service value captured once with `loader.core.run(HostControl)`.
- A fault raised while a plugin is still staging (activation inside a reload) is published with the pre-swap snapshot; the reload's own `PluginsChanged` follows with the final state. Events are losable by design: the app's log and `core.inspect` remain the source of truth.

This package exports the factory rather than a default plugin instance because `HostControl` cannot exist without the loader.
