# @lemma/core

An Effect-native, domain-neutral plugin runtime. It composes typed capabilities,
plugin-defined hooks and events, configuration, and scoped lifetimes. Applications
and plugin authors define their own contracts and behavior.
[`docs/kernel.md`](../../docs/kernel.md) holds the design rationale.

Only `effect` is a runtime dependency. Plugins are trusted, in-process modules;
there is no security sandbox. The package exports ESM JavaScript and TypeScript
declarations and targets Node.js 24 and browsers.

## Use

```ts
import { Context, Effect, Layer } from "effect";
import { definePlugin, makeCore } from "@lemma/core";

class Greeting extends Context.Tag("example/Greeting")<Greeting, string>() {}

const greeting = definePlugin({
  id: "greeting",
  provides: [Greeting],
  layer: Layer.succeed(Greeting, "Hello"),
});

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([greeting]);
      console.log(yield* core.run(Greeting));
    }),
  ),
);
```

See [`examples/hello.ts`](examples/hello.ts) for a capability implementation extended by a separate plugin through its own hook (`nix develop -c pnpm example` runs it).

## Plugin contract

`definePlugin({ id, version?, config?, provides?, requires?, exclusive?, restart?, deadlines?, layer })` declares a composition member:

- `id` uniquely identifies an instance within one core. `version` is optional diagnostic metadata, not a dependency constraint.
- `config` is an Effect Schema. `makeCore(plugins, { configs })` decodes every plugin's config before any activation; a missing value decodes as `{}`; an invalid one is a `CompositionError` (`InvalidConfig`) naming the plugin and the failing path. `layer` may be a function of the decoded config.
- `exclusive` marks a plugin that cannot coexist with its replacement (a port, a lock, a unique registration in a retained registry); a reload stops it before starting the new instance. `restart` is an Effect `Schedule` consulted after a runtime failure; without one the plugin stays failed. `deadlines` bound activation and disposal (defaults 30s and 10s, overridable per core).
- Capabilities are ordinary Effect `Context.Tag`s. Share the tags between consumers and providers; use namespaced keys. Effect identifies capabilities by their keys.
- `provides` declares exports; `requires` declares dependencies supplied by other plugins. `PluginContext`, `Hooks`, `Events`, and `Registries` are available without declaration. The runtime rejects attempts to provide these built-ins or `Scope`.
- `layer` is an ordinary Effect `Layer`. Use `Layer.scoped`, `Effect.acquireRelease`, and `Effect.forkScoped` for resources and background work. Dependencies constructed privately inside a Layer need not be declared.
- The manifest is needed for runtime graph inspection and validation: Effect's type-level requirements alone cannot describe a dynamically supplied composition. Construction and cleanup still belong to Effect, not a second dependency-injection system.

The complete graph is validated before Layers execute. Missing dependencies, duplicate ids, competing providers, and cycles produce `CompositionError`; `checkComposition(plugins, configs)` returns the same errors without running anything, so an application can decide what to leave out first. There is no implicit last-writer-wins override: replace a provider by supplying a different composition. Dependencies activate before consumers; independent plugins are ordered by code-unit id comparison. Activation receives only declared capabilities and the runtime context, not incidental capabilities from the host or unrelated plugins.

Each Layer's actual exports must exactly match `provides`. A mismatch, startup failure, defect, or deadline produces a `PluginFault` (phase `activate`) with the plugin id and original Effect cause. Pure interruption stays interruption. TypeScript checks declared inputs and outputs; runtime validation also covers untyped plugins.

Separate cores have independent capability environments and hook registrations, even when created from the same definitions. This is composition isolation, not isolation from shared module globals or operating-system access.

Contracts belong to the application or a shared plugin package. Consumers import
the contract, not the provider implementation. A capability can contain ordinary
values, functions, promises, or Effects. Effect owns setup and cleanup; a
promise-based operation must cooperate with cancellation, for example by accepting
an `AbortSignal` passed through `Effect.tryPromise`. The core does not intercept arbitrary
capability functions or automatically cancel the work they start.

Contributions to another plugin's collection belong in a core registry (below):
they are released with the contributor's scope and swapped with it on reload. A
collection a plugin keeps in its own data structure must be released with the
contributor's scope too; if it rejects duplicate names, mark the contributor
`exclusive: true` so reload can unregister the old value before installing the
new one, which incurs the same interruption gap as any exclusive resource.

## Plugin-defined hooks

The core does not enumerate application extension points. A plugin exports a token such as:

```ts
const Render = Hook.make<string, string>("example/render");
```

Contributors obtain `PluginContext` and register around middleware:

```ts
Effect.gen(function* () {
  const owner = yield* PluginContext;
  yield* owner.on(Render, (input, next) => Effect.map(next(input), (output) => output.toUpperCase()), { order: 10 });
});
```

The owning operation obtains `Hooks` and supplies its terminal behavior:

```ts
Effect.gen(function* () {
  const hooks = yield* Hooks;
  const result = yield* hooks.invoke(Render, "hello", Effect.succeed);
});
```

These snippets assume the exports are imported from `@lemma/core`; the complete runnable example shows the wiring.

The hook contract is one mechanism: awaited, sequential around middleware. A handler can modify the input passed to `next`, wrap its result, or short-circuit by not calling it. Side-effect observers can call `next` and preserve the result. Plugins needing fan-out or streams can provide those capabilities using Effect; the core does not silently detach event listeners or create queues.

- Lower `order` runs first; ties use plugin id, then that plugin's registration order.
- A call snapshots its handler array. New registrations affect subsequent calls.
- Registration captures the plugin's dependency context, but **not its activation span**. The terminal retains its caller's dependencies. Trace ancestry follows the current invocation.
- A handler may execute `next` at most once, and only before the handler finishes. Await or join that work; do not detach continuations.
- Typed hook failures and defects propagate through the same Effect channels; interruption runs finalizers. `HookError` reports invalid ordering, token collisions, or continuation misuse.
- A name identifies one shared hook token within a core. Creating another token with the same name is rejected rather than risking an incompatible handler signature.
- Registrations are owned by the plugin scope and removed on disposal.

## Events

Hooks are for the critical path and fail closed. `Event.make<Payload>(name)`
declares a notification. `Events.publish` does not propagate observer failures;
`PluginContext.observe` subscribes with a bounded queue (default 64) and an
`overflow` policy. The default `dropOldest` and optional `dropNewest` never wait
for observers. Explicit `suspend` applies backpressure until queue space is
available or the subscription closes. An observer's failure becomes a
`PluginFault` (phase `observe`) for its plugin and affects neither the publisher
nor other observers. `Events.stream` subscribes from outside a plugin. Use events
only for information that is safe to lose; applications own authoritative state
and any persistence needed to recover missed notifications.

## Registries

A registry collects what plugins offer: entries in a list other plugins read,
as opposed to an operation they intercept (a hook) or news they report (an event).

```ts
const Menu = Registry.make<{ readonly label: string }>("example/menu");
const Commands = Registry.make<Command>("example/commands", { key: (command) => command.id, unique: true });
```

A plugin contributes with its `PluginContext`; readers use `Registries`:

```ts
Effect.gen(function* () {
  const owner = yield* PluginContext;
  const remove = yield* owner.add(Menu, { label: "Open" }, { order: 10 });

  const registries = yield* Registries;
  const items = yield* registries.items(Menu); // [{ item, pluginId, order }], in order
  const updates = registries.changes(Menu); // the items now, then after each change
});
```

- Items come in `order` (lower first), then by plugin id, then in the order that plugin added them. Each carries the contributing plugin's id; `core.inspect` lists who contributes what.
- An item belongs to the plugin instance that added it. It is hidden while its plugin stages, appears when the plugin is published, and leaves when the plugin is retired or its scope closes. The effect `add` returns removes it sooner.
- With `unique`, a key held by another plugin (visible or staged) fails `add` with `RegistryError` (`Conflict`, naming the `holder`). The plugin's own replacement may take the key over, so a reload swaps without an exclusive gap.
- `items` returns an immutable array that changes only when the registry does. `changes` never backs up: a slow reader gets the latest items, not every intermediate list.
- A name identifies one token per core, as for hooks.

## Supervision

`PluginContext.background(name, work, { required })` runs work owned by the plugin's scope and reports its exit. An optional task's failure is a `PluginFault` (phase `background`) and nothing else changes. A required task's failure fails the plugin: it and every plugin depending on it stop, in reverse order, while unrelated plugins keep running. Dependents are `closed` with `haltedBy` naming the root; the root is `failed` with its fault. The runtime tracks capability resolutions by `core.run` tasks and drains only tasks that resolved an affected capability. Copying the whole context or resolving `Hooks` conservatively counts as using the composition. Unresolved failed capabilities are revoked from existing task contexts. Its capabilities disappear from new `core.run` environments, so callers that still ask for them get Effect's missing-service defect.

`PluginContext.fault(operation, cause, { fatal })` reports a failure of a plugin's own work that the core does not run, such as a callback another library calls or a view it draws: a `PluginFault` (phase `service`) attributed to the plugin, which with `fatal` fails as a required task's failure fails it, as soon as it is published when it is still starting. A stopped or retired plugin's reports are dropped: its replacement owns the faults.

Recovery is explicit: `core.restart(id)` reactivates the failed plugin and retries the dependents it halted. The named plugin must activate; a dependent that cannot is left failed, and its own dependents halted, without blocking the rest. An active plugin is left alone unless `core.restart(id, { force: true })`, which replaces it and restarts its dependents as a config change would (an `exclusive` plugin stops first). A plugin with a `restart` schedule is retried automatically; the schedule persists across failures, so one that keeps failing exhausts it rather than restarting forever. An explicit restart resets it.

`core.faults` streams `ReportedFault` values (`PluginFault` plus a core-wide,
monotonically increasing `sequence`). Delivery retains at most 256 queued entries
and drops the oldest without blocking supervision. A consumer may also hold its
current entry. Sequence gaps reveal missed entries; `core.inspect.faultSequence`
is the latest reported sequence, including faults from retired instances. A late
subscriber receives future faults only. Durable fault history belongs to the host.

Inspection records the latest fault before publishing it, even without subscribers.
Faults belong to plugin instances: replacement/restart begins with no retained
fault, removal drops its snapshot, and a retired or failed staged instance cannot
overwrite its replacement's fault. Observer failures leave their plugin active.

## Loader and reload

`makeLoader({ source, composition })` runs a composition described by data: plugin ids mapped to `{ enabled?, config? }`, resolved to definitions by a `PluginSource` the host supplies. `loader.apply(next)` changes it at runtime:

1. Plan the whole target: resolve, decode config, validate the graph. Every problem is returned at once as `ReloadError.diagnostics`, each with a plugin id, config path where relevant, and a suggestion.
2. Only plugins whose definition or config changed, plus their dependents, are touched. Replacements start in a staging scope, hidden from dispatch, while the old instances keep serving.
3. Swap: new callers see the new environment, hooks, and observers in one step. Work already in flight finishes on the environment it entered with.
4. Old instances drain, then close in reverse order. Work that outlives the dispose deadline is interrupted and counted in `ReloadReport.interrupted`.

Caller cancellation rolls back staging. Once the swap or an exclusive resource interruption has begun, the supervised lifecycle operation finishes even if disposal interrupts its initiating `core.run` caller. A caller that lost the result must inspect the resulting state. Core shutdown still owns and interrupts lifecycle work.

If any replacement fails to start, staged instances are disposed and the running composition is unchanged. `exclusive` plugins are the documented exception: they stop before the replacement starts, and if the replacement then fails they stay failed, attributed to that failure. Re-applying an unchanged composition does not restart a failed plugin; that takes `restart` or a config change.

`makeLoader({ partialStart: { required } })` starts the first composition with what can start. A plugin that fails to activate is left `failed`, with its fault in `core.inspect` (no `core.faults` subscriber exists yet to hear it), and its dependents are halted, as a restart leaves a dependent that cannot activate; `core.restart` retries it. The `required` plugins, and every plugin they need, must still activate, or the loader fails and leaves nothing behind. `apply` is never partial.

## Lifetime and failure semantics

`makeCore` mounts a fixed composition as a scoped resource: the same runtime as the loader without `apply`.

`core.run(effect)` supplies capabilities while preserving unrelated caller requirements. Enter it around a task, not around every internal function call. Each entry uses an owned Effect fiber—not a new runtime—so both caller cancellation and core shutdown interrupt and await that work. Capability calls and hook dispatch inside it do not create an extra runtime or fiber per call.

Closing the owner scope stops new work, interrupts initialization and in-flight `core.run` tasks, then disposes plugins in reverse dependency order. Cleanup defects remain visible, and remaining finalizers still run. Failed or interrupted activation rolls back immediately, even when caught inside a longer-lived caller scope. Closing an already-closed core scope cannot reactivate it.

Both `makeCore` and `makeLoader` accept `shutdownTimeout`, a total limit on the
closing caller's wait, including active tasks and lifecycle supervision. It
defaults to the core's `deadlines.dispose` (10 seconds), independently of per-plugin
deadlines. Expiry surfaces a `ShutdownTimeout` defect from scope closure and is
retained as `core.inspect.shutdownFault`. A plugin disposal deadline may surface
its attributed fault sooner. Scope finalizers use the defect channel because
Effect finalizers cannot have typed failures.

Cleanup continues after a timeout. Inspection stays `closing` and new `core.run`
work is rejected until cleanup finishes; it then becomes `closed`, retaining any
shutdown timeout for inspection. During shutdown, resources remain alive until
active work, lifecycle operations, and earlier disposals finish. Providers are
kept until their dependents actually finish cleanup. A permanently stuck finalizer
can therefore retain resources permanently. Returning a timeout never means that
work was killed or resources were released. Reload disposal deadlines still allow
the applied composition to proceed; shutdown also awaits those earlier disposals.

Cancellation is cooperative. A synchronous loop blocking the event loop prevents
deadline timers from running. Prefer `PluginContext.background` over raw
`Effect.forkScoped` so failures are attributed. Detached fibers, raw timers, and
other unmanaged work are outside these guarantees.

Rollback releases acquired resources and registrations. It cannot undo arbitrary external writes, network requests, or actions performed during module import. A retained capability value is also not revoked by magic: do not use capabilities outside their owner scope. `core.run` and hook dispatch reject use after closure.

## Inspection and tracing

`core.inspect` returns a detached snapshot of plugin identities, lifecycle state, latest fault, provided/required capability keys, ordered hook ownership, and event observers. It does not expose implementations or configuration secrets.

Activation, disposal, and each middleware execution emit native Effect spans with `plugin.id`, optional `plugin.version`, and hook name/order where applicable. `PluginContext.trace(name, effect)` attributes custom capability operations without proxying their implementations. Direct arbitrary function calls are not automatically intercepted. Install an Effect tracer around the host program to export spans; no telemetry destination is configured by the core.

These spans and composition snapshots describe runtime provenance. Applications
own durable audit history, persistence, domain events, and payload redaction.
Runtime-generated spans do not include hook arguments/results or plugin configuration.

## Develop

From the repository root:

```sh
nix develop -c pnpm core:check                # type-check
nix develop -c pnpm core:test                 # contract, lifecycle, failure, and property tests
nix develop -c pnpm package:check             # install the packed package into a temporary consumer
nix develop .#browser -c pnpm browser:check   # the same, plus a DOM consumer in Chromium
nix develop -c pnpm perf:check                # build, then core:bench and core:stress
```

The package is private. `pnpm --filter @lemma/core pack` builds and packs it
for installation into another application; Effect stays an external dependency.

`package:check` checks the emitted declarations and runs a consumer through the
package export, outside this workspace: provider replacement, dependent
reconstruction, cleanup, and an HTTP listener. Its temporary install may need
network access. `browser:check` also drives a DOM consumer in Chromium.

The property test (`tests/sequences.test.ts`) runs random
load/reload/fail/restart sequences against a fault-injecting fixture and checks
resource, registration, and dependency invariants after every step.
`LEMMA_SEQUENCE_RUNS` runs more cases, `LEMMA_SEQUENCE_SEED` fixes the seed, and
a failing run prints the `LEMMA_SEQUENCE_PATH` that replays it.

`core:bench` reports warm microbenchmarks (direct Effects, hook dispatch at
several chain lengths with tracing on and off, event publishing, `core.run`
entry, mounting and disposing, reloading one plugin) as median/min/max batch
means, not per-request percentiles. `core:stress` measures a cold package
import, operation latencies, and heap/RSS across 200
mount/reload/fail/restart/dispose cycles after 20 warmup cycles, forcing GC
every 20 and asserting resource ownership. The packed consumers also measure
loopback request p99 and throughput, and the minified browser bundle's size.
These synthetic workloads measure framework overhead, not an application's
performance.

The budgets and their reference environment are in
[`bench/budgets.ts`](bench/budgets.ts). Results are advisory:
`LEMMA_PERF_ENFORCE=1` turns a budget miss into a failure (measure on an idle,
comparable machine), and `LEMMA_BENCH_OUTPUT_DIR` writes dated JSON artifacts.
