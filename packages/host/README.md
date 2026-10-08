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

## The host runtime

The host provides `Paths`, `HostControl`, `Interaction`, and the host API
version to its plugins itself: `hostRuntime` (`src/runtime.ts`) is the
loader's `provide`, so none of them is a plugin, has a row, or can be
replaced ([configuration](../../docs/configuration.md)). Their contracts are
documented where `@lemma/contracts` declares them. The runtime is built inside
`makeLoader`, before the loader value exists, so the `HostControl` handle
main.ts builds reaches the loader through a `Deferred<Loader>`, and its methods
wait until the composition is up (see `tests/runtime.test.ts`).
`reportFaults` logs each plugin fault and publishes it as an error `Notice`
from that plugin and `PluginsChanged`, recording it in the fault history first
so the list it publishes has it. The runtime is not a plugin, so its own
failures are no `PluginFault`: what it starts logs them. Three kernel facts shape
the rest:

- `Loader.apply` retires the current revision and drains in-flight `core.run` work before swapping. A `HostControl.reload` executed _inside_ `core.run` therefore waits on itself until the dispose deadline. Call it from plugin code (a transport's handler runs in its plugin scope); the app's own reload, when a config file changes, applies outside `core.run` and outside any plugin's work.
- A plugin's disposal waits for the work run with its registry items, such as a channel call it serves or a command it registered, and that work knows it is the plugin's (`Admitted`). `HostControl.configure`, `reload`, and `restart` ask `deferral` (`src/deferral.ts`) whether the change restarts a plugin whose work is making it, the transport serving the request included: if so, each checks the change (a configure writes it too), answers `deferred`, and applies it once that work has ended, rather than wait on the work that waits on it. A reload knows what it restarts by comparing what it would run with what runs (`changedBetween`). A channel stream is no such work: the transport runs it outside `Admitted`, since it ends as soon as its plugin leaves. So a change a stream asks for interrupts the stream midway, and `hostRuntime` runs each change on a fiber of its own: the change, and the `PluginsChanged` and `UiChanged` it publishes, finish without their caller.
- A fault raised while a plugin is still staging (activation inside a reload) is published with the pre-swap snapshot; the reload's own `PluginsChanged` follows with the final state. Events are losable by design: the app's log and `core.inspect` remain the source of truth.
