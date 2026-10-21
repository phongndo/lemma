# @lemma/host

The host process. Importing the package runs it (`src/start.mjs`, which starts
`src/main.ts`, [below](#its-start)): it resolves
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
processes, because session `request` events record it. `loadLocalPlugins`
imports each edit of a plugin file as a new module and keeps what only its
last few versions made, so a file put back to the version still running
leaves it running, but Node.js's module cache, which no API evicts, keeps every
version imported, so a long run of edits grows the host by each one's code.
A plugin whose code is edited often, or may hang, can run that code in a
worker thread, which takes its module cache with it when it stops, as
[isolated](../../examples/isolated/README.md) runs its tools.

## Its start

What the host loads as it starts is what its plugins import at their top
level, so a bundled plugin imports a dependency only some of its calls use
where those calls run: Playwright with `browser.chromium`'s first launch, the
MCP SDK with a server's first connect, codemode's sandbox with its first
script. `tests/startup.test.ts` holds the bundled plugins to that, and to a
number of modules.

Most of a start is compiling the modules the host loads and stripping their
types, which Node.js's compile cache keeps from one start to the next:
`src/start.mjs` turns it on and then imports `src/main.ts`, as the cache holds
only what loads after it is on. A warm cache starts the host in about two
thirds of the time, and spares it Node's type stripper (10–20 MB a thread),
which is why the one module loaded before it is JavaScript. The stall
watchdog's worker, [below](#a-blocked-event-loop), uses it too.

- **Where.** The checkout's `packages/host/node_modules/.cache/compile`, so
  every home, shell, and test's host shares it. `NODE_COMPILE_CACHE` names
  another directory; `NODE_DISABLE_COMPILE_CACHE=1` turns it off. It can be
  deleted at any time. What the host's tools run does not inherit it.
- **Edits.** Each module's entry is checked against its source, so an edited
  file (this checkout's, or a plugin file's) compiles again. Each version of a
  plugin file the host loads keeps an entry of its own.
- **When it is written.** Once the host has started, and again as it exits, so
  a host killed later (a supervised one's group) keeps it.

`pnpm start` and `pnpm dev` also cap V8's young generation
(`--max-semi-space-size=16`, in MB). Uncapped, on a machine with memory to
spare, it grows to 64 MB as the host starts and works, and stays committed
until the host has idled for minutes: capped, a host holds about 25 MB less
once started and 65 MB less after a few turns, for the same CPU a turn
(measured end to end) and a harness benchmark step about 7% slower. It is a
flag of Node's, which a running process cannot change, so it is each
launcher's to pass; `lemma serve` and the desktop app do not yet.

## The host runtime

The host provides `Paths`, `HostControl`, `Interaction`, `Trace`, and the host
API version to its plugins itself: `hostRuntime` (`src/runtime.ts`) is the
loader's `provide`, so none of them is a plugin, has a row, or can be
replaced ([configuration](../../docs/configuration.md)). `Trace` is what the
host keeps of its own running: main.ts runs its program under a span
collector (`makeSpanCollector`), so every span its plugins' work ends is kept,
in memory and bounded, and records each composition change (a reload, a
configure, a restart) with what it did or why it was refused. Their contracts are
documented where `@lemma/contracts` declares them. `makeHostChanges`
(`src/control.ts`) makes every change to the composition, one at a time, and
serves `HostControl`; main.ts gives it the files and the loader, and
`tests/runtime.test.ts` gives it its own. The runtime is built inside
`makeLoader`, before the loader value exists, so the `HostControl` handle
reaches the loader through a `Deferred<Loader>`, and its methods wait until
the composition is up. A load becomes the one the catalog and `configure`
reason about only once the loader has accepted it; while it is applied, the
plugin source resolves its plugins.
`reportFaults` logs each plugin fault and publishes it as an error `Notice`
from that plugin and `PluginsChanged`, recording it in the fault history first
so the list it publishes has it. The runtime is not a plugin, so its own
failures are no `PluginFault`: what it starts logs them. These shape
the rest:

- A change that is refused leaves the config file as it was: a configure that wrote it puts it back. When the file cannot be put back, the change's error says so, the host logs it, and the host remembers the file as holding the change, so it does not take the file for put back.
- `Loader.apply` retires the current revision and drains in-flight `core.run` work before swapping. A `HostControl.reload` executed _inside_ `core.run` therefore waits on itself until the dispose deadline. Call it from plugin code (a transport's handler runs in its plugin scope); the app's own reload, when a config file changes, applies outside `core.run` and outside any plugin's work.
- A plugin's disposal waits for the work run with its registry items, such as a channel call it serves or a command it registered, and that work knows it is the plugin's (`Admitted`). `HostControl.configure`, `reload`, and `restart` ask `deferral` (`src/deferral.ts`) whether the change restarts a plugin whose work is making it, the transport serving the request included: if so, each checks the change (a configure writes it too), answers `deferred`, and applies it once that work has ended, rather than wait on the work that waits on it. Each knows what the change restarts by asking the loader (`Loader.affected`), which decides it as applying the change would. The transport runs each request as such work until its reply has left the connection, which only it can tell, so a change restarting it applies once the client has its answer ([transport.server](../../domains/transport/server/README.md)). A channel stream is no such work: the transport runs it outside `Admitted`, since it ends as soon as its plugin leaves. So a change a stream asks for interrupts the stream midway, and `hostRuntime` runs each change on a fiber of its own: the change, and the `PluginsChanged` and `WebChanged` it publishes, finish without their caller.
- A fault raised while a plugin is still staging (activation inside a reload) is published with the pre-swap snapshot; the reload's own `PluginsChanged` follows with the final state. Events are losable by design: the app's log and `core.inspect` remain the source of truth.

## A blocked event loop

A plugin stuck in synchronous work (a loop that never yields, a huge parse)
stops every session with it, and nothing on the loop can notice.
`watchStalls` (`src/stall.ts`) watches from a worker thread instead.

- **How it tells.** The loop bumps a counter in shared memory every 100 ms.
  When the counter has not moved for a second, the worker writes a line to
  stderr at once, and another naming the plugin once its stacks are read
  (`lemma: the event loop has been blocked for 1.2 s, running spinner's code (100% of its stacks)`),
  while the loop is still blocked. It writes to the file descriptor directly,
  because the thread that prints is the one blocked.
- **What it ignores.**
  - The worker's own late ticks: the machine slept, or the process was stopped.
  - Any stall while an inspector is open (`--inspect`, a debugger's terminal):
    a loop held at a breakpoint cannot be told from a stalled one.
- **Whose code it was.** The worker reads the blocked thread's stack five
  times through the inspector. Each read evaluates `new Error().stack` on that
  thread, which the inspector serves between the instructions it runs, in
  about a millisecond, pausing nothing. It names the plugin whose code is
  innermost on most of the stacks, from where each plugin's code is
  (`CodeOwner`):
  - a bundled plugin's package (`domains/<domain>/<name>`);
  - a local plugin's file or folder, through any symlink (one linked into the
    plugins directory), as stack frames name files.

  The worker hears these as each load is applied, before its plugins start.

  Code in the kernel, in Effect, or in the host counts for the plugin that
  called it.

- **Why stacks, not a profile.** A CPU profile started after the loop began
  misses the loop's own frame once V8 has optimized it, and names its caller
  instead, often the kernel.
- **Where it cannot tell.** A thread blocked outside JavaScript (a
  synchronous child process, a read of a slow mount) answers a stack read only
  once it returns: the stall is said at once all the same, without a plugin.
  Where the runtime has no inspector, it is said without a plugin too.
- **Once the loop runs again**, the stall is logged and kept in the trace as
  a `host.stall` span over its time. The span carries `stall.ms`, and
  `plugin.id` and `stall.share` when whose code it was could be told, so the
  Trace panel shows it under that plugin.
