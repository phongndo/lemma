# @lemma/core

An Effect-native, domain-neutral plugin runtime. It composes typed capabilities,
plugin-defined hooks and events, configuration, and scoped lifetimes. Applications
and plugin authors define their own contracts and behavior.
[`DESIGN.md`](DESIGN.md) holds the design rationale.

Only `effect` is a runtime dependency. Plugins are trusted, in-process modules;
there is no security sandbox. The package exports ESM JavaScript and TypeScript
declarations and targets Node.js 24 and browsers.

## Use

A plugin names what it requires and provides, and a `setup` that receives the
one and returns the other. Write it with Effects, or with promises from
`@lemma/core/plain`; the core treats both alike.

```ts
import { Context, Effect } from "effect";
import { definePlugin, makeCore } from "@lemma/core";

class Greeting extends Context.Service<Greeting, string>()("example/Greeting") {}

const greeting = definePlugin({
  id: "greeting",
  config: { text: "Hello" }, // defaults; a Schema works too
  provides: { greeting: Greeting },
  setup: (_, { config }) => Effect.succeed({ greeting: config.text }),
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

`definePlugin({ id, version?, config?, provides?, requires?, exclusive?, restart?, deadlines?, setup })` declares a composition member, as does the same with a `layer` in place of `setup` (below):

- `id` uniquely identifies an instance within one core. `version` is optional diagnostic metadata, not a dependency constraint.
- `config` is an Effect Schema or, with `setup`, the defaults one is derived from (`configSchema`: each field takes its default's type and decodes to it when absent; nested objects default field by field). `makeCore(plugins, { configs })` decodes every plugin's config before any activation; a missing value decodes as `{}`; an invalid one is a `CompositionError` (`InvalidConfig`) naming the plugin and the failing path. Write the Schema for titles, descriptions, or constraints.
- `exclusive` marks a plugin that cannot coexist with its replacement (a port, a lock, a unique registration in a retained registry); a reload stops it before starting the new instance. `restart` is an Effect `Schedule` consulted after a runtime failure; without one the plugin stays failed. `deadlines` bound activation and disposal (defaults 30s and 10s, overridable per core).
- Capabilities are ordinary Effect `Context.Service` keys. Share the keys between consumers and providers; use namespaced key names. Effect identifies capabilities by their key names.
- `provides` declares exports; `requires` declares dependencies supplied by other plugins: with `setup`, by name (`{ store: Store }`), the names under which `setup` receives and returns them; with `layer`, as a list of tags. `PluginContext`, `Hooks`, `Events`, and `Registries` are available without declaration. The runtime rejects attempts to provide these built-ins or `Scope`.
- `setup(services, plugin)` runs when the plugin activates, in its scope: an Effect, or a generator function yielding Effects as `Effect.gen` takes. `plugin` is the `PluginContext` with the decoded `config` and a `signal` that aborts when the plugin stops, before its own finalizers run. It returns the provided services by name. TypeScript checks that it uses only what it requires and the built-ins, and returns what it provides.
- `layer` is an ordinary Effect `Layer`, the form `setup` is built on. Use `Layer.effect` (its Effect may use the layer's `Scope`), `Effect.acquireRelease`, and `Effect.forkScoped` for resources and background work. Dependencies constructed privately inside a Layer need not be declared. `layer` may be a function of the decoded config.
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

## Plugins written with promises

`@lemma/core/plain` defines plugins with promises instead of Effects. The
plugin has the same shape, and the core plans, orders, supervises, and replaces
it as it does any other:

```ts
import { definePlugin } from "@lemma/core/plain";

export default definePlugin({
  id: "audit",
  config: { ask: ["shell"] },
  requires: { store: Store },
  setup: async ({ store }, { config, on, onCleanup }) => {
    const seen = await store.get("audit"); // Store's Effects, as promises
    on(Save, async (item, next) => (config.ask.includes(item.kind) ? next(item) : "skipped"));
    onCleanup(() => store.put("audit", seen));
  },
});
```

- **Services** arrive as `Plain<S>`: a method returning an Effect returns a
  promise of its value, one returning a stream an async iterable, and an Effect
  member becomes a method. A failure rejects with its error, marked so that
  rethrowing it keeps it a typed failure; a defect rejects with the defect. A
  generic or overloaded method keeps one signature through the mapping; a
  contract restores it with a phantom `"~plain"` member (see `Plain`).
- **Context.** A call runs in the context of the work that led to it (a hook's
  operation, an event, the activation), so it keeps that work's references and
  trace, and stops when that work is interrupted. It always runs as the plugin
  that makes it, with its own `PluginContext` and `Scope`, whoever's work called
  the code (a guard another plugin runs). Where the runtime has
  `AsyncLocalStorage` (Node.js, found without importing it, so browser bundles
  are unaffected; `followsAwait` says so) this follows `await` and `.then`;
  elsewhere it holds until the first one, and later calls run in the plugin's
  own context, stopping when it stops.
- **`setup`** may be `async`, and receives the `PluginContext` operations as
  promise-based functions (`on`, `add`, `observe`, `publish`, `invoke`,
  `items`, `changes`, `background`, `fault`, `run`) plus `config`, `signal`, and
  `onCleanup`. The plugin is active once setup has returned and every call it
  made has settled (calls a background task makes are not setup's). A call
  that failed, which setup neither awaited nor caught, fails the activation, as
  does a throw; neither is ever an unhandled rejection. Start long-running work
  with `background`, not by leaving a promise behind.
- **Hook handlers** return a value, a promise, or `next(input)`. Returned from a
  function that is not `async`, `next(input)` runs the rest of the chain in
  place, on the caller's fiber: a pass-through costs about 1.4 times an Effect
  handler (`bench/budgets.ts`). Awaiting `next` costs a promise per handler. A
  handler that declares a third parameter receives a signal, aborted if the
  operation is interrupted; calls the handler made stop then too.
- **Errors.** A throw of an `Error` is a defect; `throw fail(error)` (or
  returning an Effect) is a typed failure, and so is a thrown value that is not
  an object (a string), which carries no stack and so was meant.
- **Streams** read as async iterables end when the work that started reading
  them is interrupted, or the plugin stops.
- **Stopping.** When the plugin stops, its signal aborts, then its cleanups run
  (`onCleanup`, last first, each even if another throws). Its services still
  work for them: what a cleanup calls runs until cleanup is over, however long
  it takes within the dispose deadline. Then its services refuse calls with
  `PluginStopped`, so a timer or promise it left behind cannot act through them:
  a method that has returned Effects rejects (a refusal nobody awaits is logged
  as a warning), any other throws where it is called, `items` throws, and
  `publish` drops the event. A setup that fails aborts its signal before its
  cleanups run.
- **Unawaited failures.** A call that fails with nothing awaiting or chaining its
  promise is reported as the plugin's fault (`unawaited <operation>`), not as an
  unhandled rejection that would end a Node.js process.
- **Reloading.** `handoff(() => state)` and `previous` carry state to the
  replacement, as `PluginContext.handoff` does, checked by `carry` when given.
- **Services as data.** Plain objects inside a service are converted as the
  service is; class instances inside it (a `Map`, a `Date`) are data, left as
  they are. A service that is itself a class instance keeps its prototype,
  getters, and private fields behind a proxy.
- **Providing.** `setup` returns services as their contracts declare them; it does
  not convert them. `asEffect(async (…) => …)` turns an async function into one
  returning an Effect, for a contract whose methods return Effects.

An application with its own way of writing plugins (a UI framework's) builds on
`definePlugin(definition, { services, run })`. `services: "raw"` hands services
over as provided, for contracts that are promise-based already, and a function
gives its own view. `run` wraps the call to setup in a reactive root or an
error boundary.

### Callbacks a contract takes

A contract that takes callbacks (a guard, a handler a library calls) types them
as `Awaitable<A, E, R>`: a value, a promise, or an Effect. Its provider runs
each with `awaitable(() => callback(…))`. That way plugins written either way
can supply them, and promise code runs in the caller's context. A value
succeeds at once with no promise or extra turn. A callback that declares a
parameter receives a signal, aborted when the Effect is interrupted.

## Testing a plugin

`@lemma/core/testing` starts one plugin the way an application would, with
stand-ins for what it requires, and returns promise-based handles:

```ts
import { testPlugin } from "@lemma/core/testing";

const tested = await testPlugin(audit, { provide: [[Store, fakeStore]], config: { ask: [] } });
expect(await tested.run(Effect.flatMap(Saver, (saver) => saver.save(item)))).toBe("skipped");
const fault = await tested.waitForFault((fault) => fault.phase === "background");
await tested.close();
```

It fails as `makeCore` does: a `CompositionError` when the plugin cannot plan, a
`PluginFault` when it cannot start. `faults` holds what is reported while it
runs, including each plugin's latest fault from its start. `with` runs other
plugins beside it.

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

A replacement can start where its predecessor left off. `PluginContext.handoff(save)` registers what the running instance hands over; `save` runs when the replacement starts staging (an `exclusive` plugin's once its work has drained, just before it stops, so everything it did is included; otherwise changes after that moment are not carried), and a structured clone of its result is the replacement's `PluginContext.previous`. The clone means the two never share an object: a replacement that fails to start cannot change the state the old instance keeps serving with. State must therefore be what `structuredClone` copies (data, `Map`, `Set`, `Date`; not functions or sockets); what it cannot copy is reported as the old instance's fault, and the replacement starts fresh. A first start, a restart after a failure (a failed instance's state is not trusted), and a `save` that throws (reported as the old instance's fault) all start with `previous` undefined. With `setup`, a `carry` Schema checks what arrives first: state whose shape changed in an update fails to decode, is reported as the plugin's fault (`handoff`), and the plugin starts fresh instead of trusting it. The state stays in memory; durable state belongs to the plugin's own storage.

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

Activation, disposal, and each middleware execution emit native Effect spans with `plugin.id`, optional `plugin.version`, and hook name/order where applicable. With tracing turned off (`Effect.withTracerEnabled(false)`) a handler gets no span at all, which makes dispatch several times cheaper (`bench/budgets.ts`). `PluginContext.trace(name, effect)` attributes custom capability operations without proxying their implementations. Direct arbitrary function calls are not automatically intercepted. Install an Effect tracer around the host program to export spans; no telemetry destination is configured by the core.

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
[`bench/budgets.ts`](bench/budgets.ts). Timing budgets are advisory:
`LEMMA_PERF_ENFORCE=1` turns a miss into a failure (measure on an idle,
comparable machine). Size budgets (the browser bundle) are the same on every
machine and always fail. `LEMMA_BENCH_OUTPUT_DIR` writes dated JSON artifacts.
`core:test` runs both benchmarks with tiny counts (`LEMMA_BENCH_ITERATIONS`,
`LEMMA_BENCH_SAMPLES`, `LEMMA_STRESS_CYCLES`), so they cannot rot unnoticed.

A number from one machine says little; a change between two builds measured
side by side does. `node scripts/bench-compare.ts [--base <ref>] [--runs <n>]`
checks the base revision (default: the merge base with `origin/main`) out
beside the working tree, alternates the microbenchmarks of the two, and reports
a change only when a Mann-Whitney U test finds it significant across `--runs`
pairs (default 10), corrected for the number of benchmarks, and it is beyond
`--threshold` (default 10%), as Go's benchstat does. `--fail` exits non-zero on
a slowdown.
