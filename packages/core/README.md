# @lemma/core

An Effect-native, domain-neutral plugin kernel. It composes typed capabilities,
plugin-defined hooks and events, configuration, and scoped lifetimes.
Applications and plugin authors define their own contracts and behavior.
[`DESIGN.md`](DESIGN.md) holds the design rationale.

Only `effect` is a runtime dependency. Plugins are trusted, in-process modules;
there is no security sandbox. The package exports ESM JavaScript and TypeScript
declarations, and targets Node.js 24 and browsers.

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

[`examples/hello.ts`](examples/hello.ts) has a capability implementation that a
separate plugin extends through its own hook. `nix develop -c pnpm example` runs
it.

## Plugin contract

`definePlugin({ id, version?, uses?, implements?, config?, provides?, requires?, exclusive?, deadlines?, setup })`
declares a composition member, as does the same with a `layer` in place of
`setup` (below).

- `id` identifies an instance uniquely within one core. `version` is
  diagnostic metadata, not a dependency constraint.
- `uses` and `implements` name the contract versions it is written against
  and implements, each `name@version` with a whole-number version
  (`"example/store@2"`; `ContractVersions`). Planning refuses a malformed
  entry, or a plugin using another version of a contract than its implementer,
  with a `CompositionError` (`IncompatibleContract`) naming both versions and
  the implementer. A contract no plugin implements constrains nothing: `uses`
  is not a dependency, and starts nothing. Write `uses` as a literal, since a
  version read from the contract's own module would always match.
- `config` is an Effect Schema, for titles, descriptions, or constraints. With
  `setup` it may be the defaults instead, from which `configSchema` derives the
  Schema. Each field takes its default's type and decodes to it when absent;
  nested objects default field by field.
- `exclusive` marks a plugin that cannot coexist with its replacement, such as
  one holding a port, a lock, or a unique registration in a retained registry.
  A reload stops it before starting the new instance.
- `deadlines` bound activation and disposal: 30s and 10s by default, which a
  core can override.
- `provides` declares exports, and `requires` dependencies, supplied by other
  plugins or by the application
  ([below](#capabilities-the-application-provides)). With `setup` both are by
  name (`{ store: Store }`), the names `setup` receives and returns them under.
  With `layer` both are lists of tags.
- `PluginContext`, `Hooks`, `Events`, and `Registries` are available without
  declaration; `builtinKeys` holds their keys. The runtime refuses a plugin
  that provides one of them, or `Scope`.
- Capabilities are Effect `Context.Service` keys, shared between consumers and
  providers. Namespace their names: Effect identifies capabilities by them.
- `setup(services, plugin)` runs in the plugin's scope as it activates. It is
  an Effect, or a generator function yielding Effects as `Effect.gen` takes,
  and returns the provided services by name. `plugin` is the `PluginContext`,
  with the decoded `config` and a `signal` that aborts when the plugin stops,
  before its own finalizers run. TypeScript checks that it uses only what it
  requires and the built-ins, and returns what it provides.
- `layer` is an Effect `Layer`, the form `setup` is built on, or a function of
  the decoded config. Use `Layer.effect` (its Effect may use the layer's
  `Scope`), `Effect.acquireRelease`, and `Effect.forkScoped` for resources and
  background work. Dependencies it constructs privately need no declaration.

The whole graph is validated before any plugin's Layer runs, after the
application's services (below) are built; they are released if it fails.

- `makeCore(plugins, { configs })` decodes every plugin's config first, a
  missing one as `{}`. An invalid one is a `CompositionError` (`InvalidConfig`)
  naming the plugin and the failing path.
- Missing dependencies, duplicate ids, competing providers, cycles, and a
  plugin providing what the runtime or the application provides
  (`ReservedCapability`) are `CompositionError`s too. No provider overrides
  another: replace one by supplying a different composition.
- `checkComposition(plugins, configs, { provided })` returns the same errors
  without running anything, so an application can decide what to leave out
  first. `provided` is the application's `provide.provides`.
- An application that plans for itself uses the core's pieces:
  `requiredBy(plugins, providers, roots)` says what must run for `roots` to
  run, and `firstIssue(issue)` where a failed decode went wrong (its path and
  message).
- Dependencies activate before consumers, independent plugins in code-unit
  order of their ids. An activation receives only declared capabilities and the
  runtime context.

Each Layer's actual exports must match `provides` exactly: the core checks them
as it activates, so untyped plugins are held to it too. A mismatch, startup failure, defect, or deadline is a
`PluginFault` (phase `activate`), with the plugin id and the original Effect
cause; pure interruption stays interruption.

Separate cores have independent capability environments and hook
registrations, even when made from the same definitions. That isolates
compositions, not shared module globals or access to the operating system.

Contracts belong to the application or a shared plugin package; consumers
import the contract, not the provider. A capability holds values, functions,
promises, or Effects, and Effect owns its setup and cleanup. The core neither
intercepts capability functions nor cancels the work they start, so a
promise-based operation cooperates with cancellation itself (accepting the
`AbortSignal` that `Effect.tryPromise` passes, say).

A collection a plugin keeps in its own data structure, rather than in a core
registry (below), must release a contribution with the contributor's scope. If
it refuses duplicate names, its contributors are `exclusive`, so a reload
unregisters the old value before installing the new one.

## Capabilities the application provides

The application that embeds the core is the runtime its plugins are written
against. It provides capabilities of its own with `provide`, on `makeCore` and
`makeLoader` alike:

```ts
class Clock extends Context.Service<Clock, { readonly now: () => number }>()("example/Clock") {}

const provide = { provides: [Clock], layer: Layer.succeed(Clock, { now: Date.now }) };
const core = makeCore(plugins, { provide }); // makeLoader({ source, composition, provide }) alike
```

- `provides` lists them, each once, so planning and `checkComposition` count on
  them without building anything.
- `layer` builds exactly those services. TypeScript catches a listed one it
  lacks. The core catches an unlisted extra as it builds, naming the missing
  and undeclared keys, as a defect from `makeCore` or a `ReloadError`
  diagnostic from `makeLoader`.
- Several services are `Layer.mergeAll(…)`. Provide what the layer needs from
  the application into it beforehand (`Layer.provide`).
- Plugins require them as any other capability, and `core.run` supplies them.
- A plugin providing one is a `CompositionError` (`ReservedCapability`), never
  an override. So is an application that provides a built-in or `Scope`, and
  one that lists a capability twice (`DuplicateCapability`).
- The layer may use `Hooks`, `Events`, and `Registries`, to invoke a hook,
  publish an event, or read a registry. It has no `PluginContext`: registering
  a handler or an item belongs in a plugin. Of the caller's context it sees
  only runtime settings, as an activation does.
- It is built once, before the first plugin activates. It is released after
  the last plugin is disposed and hooks, events, and registries have closed,
  within the core's dispose deadline and `shutdownTimeout`.
- The services are fixed for the life of the core or loader: no change,
  restart, or plugin failure stops, replaces, or revokes them, and none is ever
  a plugin's `haltedBy`. A service over changing state is a stable handle over
  it; changing the services takes a new core.
- A build failure fails `makeCore` with the layer's error, and `makeLoader`
  with a `ReloadError` whose diagnostic names no plugin. Either leaves nothing
  behind.
- The application's failures are not `PluginFault`s, and nothing supervises the
  work its layer starts: the application reports its own.

[`DESIGN.md`](DESIGN.md#the-applications-capabilities) says why they are fixed,
take no `PluginContext`, and cannot be overridden.

## Plugins written with promises

`@lemma/core/plain` defines plugins with promises instead of Effects. The
plugin has the same shape, and the core plans, orders, supervises, and replaces
it as any other:

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

- **Services** arrive as `Plain<S>`. A method returning an Effect returns a
  promise of its value, one returning a stream an async iterable, and an Effect
  member becomes a method. A failure rejects with its error, marked so that
  rethrowing it keeps it a typed failure; a defect rejects with the defect. A
  generic or overloaded method keeps one signature through the mapping.
- **Context.** A call runs in the context of the work that led to it (a hook's
  operation, an event, the activation): it keeps that work's references and
  trace, and stops when that work is interrupted. It always runs as the plugin
  making it, with its `PluginContext` and `Scope`, whoever's work called the
  code (a guard another plugin runs).
  - With `AsyncLocalStorage`, which the core finds without importing it (so
    browser bundles are unaffected), the context follows `await` and `.then`.
    Elsewhere it holds until the first `await`, and later calls run in the
    plugin's own context, stopping when it stops.
  - What a plugin registers (a handler, an observer, an item, a background
    task) is its own: a handler registered during one operation keeps none of
    that operation's references for the next.
- **`setup`** may be `async`. It receives `config`, `signal`, `onCleanup`, the
  helpers below, and the `PluginContext` operations as promise-based
  functions: `on`, `add`, `observe`, `publish`, `invoke`, `items`, `changes`,
  `background`, `fault`, `run`, and `trace`. `trace(name, fn)` runs `fn` in a
  span attributed to the plugin, under the span of the work that called it.
  - The plugin is active once setup has returned and every call it made before
    returning has settled. Calls a background task or a loop makes later are
    not setup's.
  - A call that failed, which setup neither awaited nor caught, fails the
    activation, as a throw does. Neither is ever an unhandled rejection.
  - Start long-running work with `background`, not by leaving a promise behind.
- **Hook handlers** return a value, a promise, or `next(input)`.
  - Returned from a function that is not `async`, `next(input)` runs the rest
    of the chain in place, on the caller's fiber: a pass-through costs about
    1.4 times an Effect handler (`bench/budgets.ts`). Awaiting `next` costs a
    promise per handler.
  - A handler that declares a third parameter receives a signal, aborted if
    the operation is interrupted. The calls the handler made stop then too, as
    do calls it makes later (a microtask it queued).
- **Errors.** A throw nobody marked is a defect. `throw fail(error)`, or
  returning an Effect, is a typed failure. A value that is not an object (a string) cannot carry a mark, so it
  is marked for the operation it was thrown in: rethrown there it is that
  failure, and elsewhere a defect. So an Effect typed as unable to fail never
  fails with a stray string.
- **Streams** read as async iterables fail as calls do, with their typed error.
  They end when the work reading them is interrupted, or the plugin stops; what
  they had buffered then is not read.
- **Stopping.** When the plugin stops, its signal aborts, then its cleanups run
  (`onCleanup`), last first, each even if another throws. A setup that fails
  aborts its signal before its cleanups run.
  - Its services still work for the cleanups: what a cleanup calls runs until
    cleanup is over, within the dispose deadline. What a cleanup acquires (a
    scoped resource) is released once every cleanup is done.
  - Then its services, the application's among them, refuse its calls with
    `PluginStopped` (they go on serving the rest), so a timer or promise it
    left behind cannot act through them. A method that has returned plain
    values throws where it is called. Any other method (one that returned
    Effects, streams, or promises, or one never called) returns a refusal,
    which rejects whether awaited or read as a stream, so leaked work that
    catches never throws. A refusal nobody awaits is logged as a warning.
    `items` throws, and `publish` drops the event.
- **Unawaited failures.** A call that fails with nothing awaiting or chaining
  its promise is the plugin's fault (`unawaited <operation>`), not an unhandled
  rejection, which would end a Node.js process.
- **Timers, listeners, and callbacks.** Start them through the plugin's
  helpers. Each ends when the plugin stops, or when the cancel or removal it
  returns runs. What throws or rejects in one is the plugin's fault.
  - `after(ms, fn)` replaces `setTimeout`. `every(ms, fn)` replaces
    `setInterval`, waiting for a run to end before the next, and going on after
    one fails.
  - `listen(target, type, fn)` replaces `addEventListener`, on an
    `EventTarget` or an `on`/`off` emitter.
  - `task(name, fn)` replaces a promise left running. It resolves with what its
    work resolves with, or `undefined` when it failed or the plugin had
    stopped.
  - `action(name, fn)` wraps a function handed to a library, so it runs as its
    plugin's own work wherever it is called (another plugin's emit). One that
    rejects with `PluginStopped`, a call refused because a plugin stopped, is
    no fault.
  - Once the plugin is stopping (its signal aborted, its cleanups running),
    nothing would end what starts: `after`, `every`, and `listen` start
    nothing, and an `action` does nothing. A `task` asked then (a cleanup's
    flush) runs at once, as part of stopping.
- **Errors nothing handled.** `reportUnhandled(error)` (from `@lemma/core`) is
  for an application's last-resort handlers: a process's `unhandledRejection`
  and `uncaughtException`, and a page's `unhandledrejection`. The host
  installs it.
  - An error a plugin's work raised becomes that plugin's fault (`unhandled`),
    which neither stops it nor ends the host. A `PluginStopped` is expected: a
    call a stopped plugin made. A stopped plugin records no fault, so the
    caller logs what is not a refusal.
  - Anything else is nobody's that can be told, and ends the host, as Node.js
    would, since its state may be broken.
  - With `AsyncLocalStorage`, work follows the timers and promises it starts,
    so a plugin's stray `setTimeout` is still its own. In a browser, only
    refusals are told apart.
  - Effect work a promise-based plugin starts (a service call, the rest of a
    hook's chain, an event it publishes) runs outside its async-local context,
    as Effect code carries none; it is passed the context it needs. An error
    it leaves behind (an Effect-written plugin's stray timer) is nobody's that
    can be told, not the calling plugin's.
- **Nested services.** Objects inside a service are converted as the service
  is, down to four levels below it, and read through: a view shows what the
  object holds now. A plain object becomes an object with its keys. A class
  instance goes behind a proxy that keeps its prototype, getters, and private
  fields, a frozen one too. An object is one view however it is reached, so
  `===` holds between reads, though not with the object itself. Built-in data
  (a `Map`, a `Date`, an `Error`, a typed array), arrays, tokens (a Hook, an
  Event, a Registry), and anything deeper are left as they are. `Plain<S>`
  types them the same way.
- **Providing.** `setup` returns services as their contracts declare them,
  unconverted. A method a contract types as returning an Effect can return
  `awaitable(async () => …)`.

An application with its own way of writing plugins (a UI framework's) builds on
`definePlugin(definition, { services, run })`. `services` gives its own view of
the services, and `run` wraps the call to setup in a reactive root or an error
boundary.

### Callbacks a contract takes

A contract that takes callbacks (a guard, a handler a library calls) types them
as `Awaitable<A, E, R>`: a value, a promise, or an Effect. Its provider runs
each with `awaitable(() => callback(…))`, so plugins written either way can
supply them, and promise code runs in the caller's context. A value succeeds at
once, with no promise or extra turn. A callback that declares a parameter
receives a signal, aborted when the Effect is interrupted.

The other direction is left as it is. A function a contract hands _to_ a
callback (in a hook's input, say) returns what its contract says. A handler
written with promises runs an Effect it returns with `run`.

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

- It fails as `makeCore` does: a `CompositionError` when the plugin cannot
  plan, and a `PluginFault` when it cannot start.
- `faults` holds what is reported while it runs, including each plugin's latest
  fault from its start. `with` runs other plugins beside it.
- The `provide` stand-ins are provided as the application provides
  capabilities (above): they have no plugin rows, `inspect().provided` lists
  them, and a plugin that provides one is refused (`ReservedCapability`).

## Plugin-defined hooks

The core does not enumerate application extension points. A plugin exports a
token, contributors register around middleware, and the owning operation
supplies its terminal behavior (all from `@lemma/core`):

```ts
const Render = Hook.make<string, string>("example/render");

// A contributor, with its PluginContext:
Effect.gen(function* () {
  const owner = yield* PluginContext;
  yield* owner.on(Render, (input, next) => Effect.map(next(input), (output) => output.toUpperCase()), { order: 10 });
});

// The owning operation, with Hooks:
Effect.gen(function* () {
  const hooks = yield* Hooks;
  const result = yield* hooks.invoke(Render, "hello", Effect.succeed);
});
```

A hook is one mechanism: awaited, sequential, around middleware. A handler can
change the input it passes to `next`, wrap its result, or short-circuit by not
calling it. A side-effect observer calls `next` and keeps the result. Plugins
that need fan-out or streams provide those as capabilities, with Effect: the
core detaches no listeners and creates no queues silently.

- Lower `order` runs first. Ties go by plugin id, then by that plugin's
  registration order.
- A hook whose order means something declares **phases**: named places, in
  order (`Hook.make(name, { phases: ["shape", "fit"], defaultPhase: "shape" })`).
  - A handler names its phase (`{ phase: "fit" }`), or gets the
    `defaultPhase`. It runs after every handler of an earlier phase and before
    every handler of a later one, whatever their `order`, which places it
    within its phase. So plugins that must run after the rest say so by phase,
    not by a large `order`.
  - A phase the hook does not declare fails `on` with `HookError`
    (`InvalidOrder`, naming the phases). A declaration that orders nothing (no
    phases, one twice, or a default not among them) throws at `Hook.make`.
  - Phases cost dispatch nothing: a handler's place is worked out when it
    registers. Snapshots, `onStep`, and the `hook.phase` span attribute name a
    handler's phase, where the hook declares phases.
- A call snapshots its handler array, so new registrations affect later calls.
- A handler runs in its caller's context, with its **plugin's own services**
  laid over it: what the plugin requires, its `PluginContext` and `Scope`, and
  what its layers provided to the registrations it made while activating.
  - That holds whenever it registers. One registered later, during some
    operation or from another plugin's call, keeps none of that work's
    references or plugin. Registration keeps **no activation span** either.
  - A service provided only around such a registration is not kept. Provide it
    in the plugin's layer, or capture it as a value.
  - The terminal keeps its caller's dependencies, and trace ancestry follows
    the current invocation.
- A handler may run `next` at most once, and only before the handler finishes
  (else `HookError`). Await or join that work; do not detach continuations.
- A hook may **check** its handlers at run time, for those TypeScript never
  saw (a plugin written in JavaScript):
  `Hook.make(name, { check: { input, output } })`. Each check answers a
  one-line problem, or `undefined`: `input` sees what a handler hands `next`,
  and `output` what it returns. A problem fails the operation with `HookError`
  (`InvalidInput`, `InvalidOutput`) naming that handler's plugin, so a wrong
  shape is its fault where it was made. The caller's own input and the
  terminal's result are not checked, and a hook without a check costs nothing.
- Typed hook failures and defects propagate through the same Effect channels.
  Interruption runs finalizers.
- The core shuts its hooks as it shuts down, before it disposes any plugin.
  From then on every `invoke` fails `CoreClosed`. `hooks.closed` says whether
  it has, so work that failed can tell a failure of the shutdown from its own.
- A name identifies one shared hook token within a core. Another token with
  the same name is refused (`HookError`), rather than risking an incompatible
  handler signature.
- The plugin's scope owns its registrations, and removes them on disposal.

## Events

`Event.make<Payload>(name)` declares a notification. Use events only for
information that is safe to lose.

- `Events.publish` does not propagate observer failures.
- `PluginContext.observe` subscribes with a bounded queue (default 64) and an
  `overflow` policy. The default `dropOldest`, and the optional `dropNewest`,
  never wait for observers. An explicit `suspend` applies backpressure, until
  the queue has space or the subscription closes.
- An observer runs with its plugin's own services, as a handler does, without
  the trace parent or references of the work that registered it.
- An observer's failure is a `PluginFault` (phase `observe`) for its plugin.
  It affects neither the publisher nor other observers, and leaves the plugin
  active.
- `Events.stream` subscribes from outside a plugin.

## Registries

A registry collects what plugins offer: entries in a list other plugins read.

A plugin contributes with its `PluginContext`; readers use `Registries`:

```ts
const Menu = Registry.make<{ readonly label: string }>("example/menu");
const Commands = Registry.make<Command>("example/commands", { key: (command) => command.id, unique: true });

Effect.gen(function* () {
  const owner = yield* PluginContext;
  const remove = yield* owner.add(Menu, { label: "Open" }, { order: 10 });

  const registries = yield* Registries;
  const items = yield* registries.items(Menu); // in order, each with its pluginId
  const updates = registries.changes(Menu); // the items now, then after each change
  const result = yield* registries.run(items[0]!, (left) => work); // work with an item, inside its contributor's lifetime
  yield* registries.settled; // once no change to the composition is under way
});
```

- Items come in `order` (lower first), then by plugin id, then in the order
  that plugin added them. Each carries the contributing plugin's id, and
  `core.inspect` lists who contributes what.
- A registry declares phases as a hook does
  (`Registry.make(name, { phases, defaultPhase })`), and an item names its own
  (`{ phase }`). Items then come by phase first, each carrying its `phase`. A
  registry whose first item wins declares `["replace", "default"]`, defaulting
  to `replace`. The bundled plugin adds in `default`, so any item that names
  no phase comes before it.
- An item belongs to the plugin instance that added it. It is hidden while its
  plugin stages, and appears when the plugin is published. It leaves when the
  plugin is retired or its scope closes, or sooner through the effect `add`
  returns.
- A contribution keeps its identity while it is there, so a reader can tell
  whether the one it holds is still offered (`items.includes(contribution)`).
  A replacement's item is another contribution, even with an equal value.
- Do work with an item (call a function it carries, follow a stream it opens)
  through `run`, which makes the work part of the contributor's lifetime.
  - `run` admits work only while the contribution is there, checked in the
    same step. Otherwise it fails `RegistryError` (`Absent`). The work runs on
    its own fiber, with the caller's context, and interrupting `run`
    interrupts it.
  - `left` completes when the contribution leaves (removed, its plugin
    replaced, failed, or stopped, or the core closing), once the change that
    removed the item is complete. When a reload replaced the plugin, its
    replacement is published by then, unless it is `exclusive`: that one
    starts only once the old instance is disposed, after this work ends. Stop
    work that must not outlive the contribution (a long-lived watch) then;
    other work may finish.
  - Before the contributor's finalizers run, its disposal waits for admitted
    work, for at most the core's dispose deadline (as for drained `core.run`
    tasks). Work still running then is interrupted: `run` fails
    `RegistryError` (`Expired`), and a reload counts it in
    `ReloadReport.interrupted`.
  - Work done with an item outside `run` is not waited for, and can outlive
    the plugin's resources.
- `settled` completes once no change to the composition is under way: at once
  between changes, and otherwise once the change in progress has published or
  failed its replacements and disposed what it replaced. Changes run one at a
  time, each bounded by the core's deadlines. What replaces an item may come
  only later in the change that removed it, so work that `left` ended waits for
  `settled`, once `run` has returned, then looks again.
- Never wait for `settled` within a change (a plugin starting or stopping), nor
  within work `run` admitted, nor wait there for its contributor's disposal. A
  change waits for its plugins to start and stop, and a disposal for its
  contributor's admitted work, so each would wait on the other until a deadline.
- `Admitted` holds the work `run` admitted that the current work runs within,
  outermost first: each entry's plugin, and `ended`, which completes once that
  work has ended. Code that replaces plugins on request (an application's
  reload) reads it to tell whose work is asking, and holds back a change that
  would replace one of them until that work has ended.
- With `unique`, a key another plugin holds (visible or staged) fails `add`
  with `RegistryError` (`Conflict`, naming the `holder`). The plugin's own
  replacement may take the key over, so a reload swaps without an exclusive
  gap.
- With `check`, `add` first asks whether the value, typed or not, can be an
  item, before `key` sees it. A refused value fails `add` with `RegistryError`
  (`Invalid`, with the reason) for the plugin adding it, and never reaches
  readers. It suits a registry that untyped plugin files contribute to.
- `items` returns an immutable array, which changes only when the registry
  does. `changes` never backs up: a slow reader gets the latest items, not
  every list in between.
- A name identifies one token per core, as for hooks.

## Supervision

`PluginContext.background(name, work, { required })` runs work owned by the
plugin's scope, and reports its exit. An optional task's failure is a
`PluginFault` (phase `background`), and nothing else changes. A required task's
failure fails the plugin: it and every plugin depending on it stop, in reverse
order, while unrelated plugins keep running. Dependents are `closed`, with
`haltedBy` naming the root; the root is `failed`, with its fault.

A failure drains only the `core.run` tasks that resolved an affected
capability. Copying the whole context, or resolving `Hooks`, counts as using
the composition.

- A failed capability a task has not resolved is revoked from its context.
- New `core.run` environments lack the failed capabilities, so a caller that
  still asks for one gets Effect's missing-service defect.
- What the application provides is never revoked. A task that resolved only
  such capabilities is neither drained nor interrupted, and `haltedBy` always
  names a plugin.

`PluginContext.fault(operation, cause, { fatal })` reports a failure of a
plugin's own work that the core does not run, such as a callback another
library calls, or a view it draws. It is a `PluginFault` (phase `service`)
attributed to the plugin. With `fatal`, it fails the plugin as a required
task's failure does, and a plugin still starting fails as soon as it is
published. A stopped or retired plugin's reports are dropped: its replacement
owns the faults.

Recovery is explicit. A failed plugin stays failed until `core.restart(id)`
reactivates it and retries the dependents it halted.

- The named plugin must activate. A dependent that cannot is left failed, with
  its own dependents halted, without blocking the rest.
- An active plugin is left alone, unless `core.restart(id, { force: true })`.
  That replaces it and restarts its dependents, as a config change would; an
  `exclusive` plugin stops first.
- It returns a `ReloadReport`: what it restarted (nothing, for an active plugin
  left alone), and which dependents it left failed.

`core.faults` streams `ReportedFault` values: a `PluginFault`, plus a
core-wide, increasing `sequence`.

- Delivery keeps at most 256 queued entries, and drops the oldest without
  blocking supervision. A consumer may also hold its current entry.
- Gaps in the sequence reveal missed entries. `core.inspect.faultSequence` is
  the latest reported sequence, faults from retired instances included.
- A late subscriber receives future faults only. Durable fault history belongs
  to the host.

Inspection records the latest fault before publishing it, even without
subscribers. Faults belong to plugin instances: a replacement or restart begins
with no fault kept, removal drops its snapshot, and a retired instance, or a
staged one that failed, cannot overwrite its replacement's fault.

### Assertions

`assert(condition, message)` checks what must hold where it is used: an
argument, a result, or an invariant between two states. Both `assert` and
`Verify` (below) come from `@lemma/core` and `@lemma/core/plain`.

- It stays on in production. A broken one throws an `AssertionError`, a
  defect, which the core reports as the fault of the plugin whose work broke
  it, rather than letting that plugin go on with state it can no longer trust.
- Assert a fact on both sides of a boundary: before a write, and after reading
  it back. Assert an implication as `if (a) assert(b, …)`.
- Run a check too costly for every call (rebuilding from scratch what was kept
  incrementally) only where `Verify` is true. It is off by default. It is a
  runtime setting, so a caller that provides it (a simulation) turns it on for
  every plugin's work.

## Loader and reload

`makeLoader({ source, composition })` runs a composition described by data:
plugin ids mapped to `{ enabled?, config? }`, which a `PluginSource` the host
supplies resolves to definitions. `loader.apply(next)` changes the composition
at run time:

1. Plan the whole target: resolve, decode config, and validate the graph. Every
   problem comes back at once as `ReloadError.diagnostics`, each with a plugin
   id, a config path where relevant, and a suggestion.
2. Touch only the plugins whose definition or config changed, and their
   dependents. Replacements start in a staging scope, hidden from dispatch,
   while the old instances keep serving.
3. Swap: new callers see the new environment, hooks, and observers in one
   step. Work already in flight finishes on the environment it entered with.
4. Drain the old instances, then close them in reverse order. Each closes
   after the work run with its registry items (`Registries.run`) has ended.
   Work that outlives the dispose deadline is interrupted, and counted in
   `ReloadReport.interrupted`.

`loader.affected(next)` answers, changing nothing, which plugins `apply(next)`
would start, restart, or stop. It compares as step 2 does: a definition that is
not the same object, a config not structurally equal, or a dependent of either.
With `{ restart: ids }`, it answers what a forced `core.restart` of those ids
would restart too. Ask it before a change whose reach matters (whose work a
restart would cut off), rather than predicting the loader's answer. It answers
for what runs when asked, so act on it one change at a time.

A replacement starts fresh: no in-memory state crosses a reload. A plugin that
keeps something running through a reload (a process it started) holds it
outside its instances, keyed by its core. `Hooks`, `Events`, and `Registries`
are each one object for the life of a core, and another core's are other
objects, so a replacement finds what its predecessor kept under them, while
both run. Durable state belongs to the plugin's own storage.

Caller cancellation rolls back staging. Once the swap, or an exclusive
resource's interruption, has begun, the supervised lifecycle operation
finishes, even if disposal interrupts the `core.run` caller that started it. A
caller that lost the result must inspect the resulting state. Core shutdown
still owns and interrupts lifecycle work.

If any replacement fails to start, the staged instances are disposed, and the
running composition is unchanged. `exclusive` plugins are the exception: they
stop before the replacement starts, so they stay failed if it then fails. The
plugin whose replacement failed keeps that fault. Each other plugin stopped
with it (its dependents, another exclusive plugin) gets a fault of its own,
reported on `core.faults`, whose cause is that failure.

Re-applying an unchanged composition does not restart a failed plugin: that
takes `restart`, or a config change. `apply` changes plugins only, and the
application's services stay as they are
([above](#capabilities-the-application-provides)).

`makeLoader({ partialStart: { required } })` starts the first composition with
what can start; `apply` is never partial. A plugin that fails to activate is
left `failed`, with its fault in `core.inspect`, as no `core.faults` subscriber
exists yet to hear it. Its dependents are halted, as a restart leaves a
dependent that cannot activate, and `core.restart` retries it. The `required`
plugins, and every plugin they need, must still activate, or the loader fails
and leaves nothing behind.

[`DESIGN.md`](DESIGN.md#reload) says why a reload works this way.

## Lifetime and failure semantics

`makeCore` mounts a fixed composition as a scoped resource: the loader's
runtime, without `apply`.

`core.run(effect)` supplies capabilities, and keeps the caller's unrelated
requirements. Enter it around a task, not around every internal function call.
Each entry uses an owned Effect fiber, not a new runtime, so both caller
cancellation and core shutdown interrupt and await that work. Capability calls
and hook dispatch inside it create no extra runtime or fiber per call.

Closing the owner scope stops new work, interrupts initialization and in-flight
`core.run` tasks, disposes plugins in reverse dependency order, and then
releases the application's services. Cleanup defects stay visible, and the
remaining finalizers still run. A failed or interrupted activation rolls back
at once, even when caught inside a longer-lived caller scope. Closing an
already-closed core scope cannot reactivate it.

`shutdownTimeout`, on `makeCore` and `makeLoader`, limits the closing caller's
whole wait, active tasks and lifecycle supervision included. It defaults to the
core's `deadlines.dispose` (10 seconds), independently of per-plugin deadlines.

- Expiry surfaces a `ShutdownTimeout` defect from scope closure, kept as
  `core.inspect.shutdownFault`. A plugin's disposal deadline may surface its
  attributed fault sooner. The application's services outlasting the core's
  dispose deadline surface an unattributed defect.
- Scope finalizers use the defect channel, because Effect finalizers cannot
  have typed failures.
- Cleanup continues after a timeout. Inspection stays `closing`, and new
  `core.run` work is refused, until cleanup finishes; inspection then becomes
  `closed`, and keeps any shutdown timeout.
- During shutdown, resources stay alive until active work, lifecycle
  operations, and earlier disposals finish, and providers until their
  dependents finish cleanup. So a permanently stuck finalizer can keep
  resources forever: a timeout never means that work was killed or resources
  were released.
- Reload disposal deadlines still let the applied composition proceed, and
  shutdown also awaits those earlier disposals.

Cancellation is cooperative: a synchronous loop blocking the event loop keeps
deadline timers from running. Prefer `PluginContext.background` over raw
`Effect.forkScoped`, so failures are attributed. Detached fibers, raw timers,
and other unmanaged work are outside these guarantees.

Rollback releases acquired resources and registrations. It cannot undo
arbitrary external writes, network requests, or actions performed during
module import. A capability value kept elsewhere is not revoked either, so do
not use capabilities outside their owner scope. `core.run` and hook dispatch
refuse use after closure.

## Inspection and tracing

`core.inspect` returns a detached snapshot (`CoreSnapshot`), with no
implementations or configuration secrets. The keys the application provides
have no plugin row: `provided` lists them, and the plugins requiring one name
it in their `requires`.

Activation, disposal, and each middleware run emit native Effect spans. They
carry `plugin.id`, the optional `plugin.version`, and the hook's name and order
where they apply. Building the application's services emits `core.provide`.

- With tracing off (`Effect.withTracerEnabled(false)`), a handler gets no span
  at all, which makes dispatch several times cheaper (`bench/budgets.ts`).
- `PluginContext.trace(name, effect)` attributes custom capability operations,
  without proxying their implementations. Direct calls of arbitrary functions
  are not intercepted.
- Install an Effect tracer around the host program to export spans. The core
  configures no telemetry destination.

`makeSpanCollector({ limit })` is such a tracer. It keeps the last `limit`
spans a program ends in memory, as plain data (`SpanRecord`), and hands them to
listeners in batches (`subscribe`). Install its `tracer` around the program
(`Effect.withTracer`), and mark every span of a piece of work with
`Effect.annotateSpans` (a request, a job) so a reader can filter by it. Keeping
a span as data costs about 0.8us over Effect's native span
(`bench/budgets.ts`).

A hook may say what a trace shows of each handler, with
`Hook.make(name, { summary: { input, output } })`. The summary returns a few
plain values (counts, names, never the payload) for the span's `hook.in.*`,
`hook.next.*` (what it passed on), and `hook.out.*`. It is asked only while
tracing.

The caller of an operation may hear each handler's part as it ends
(`HandlerStep`), with `hooks.invoke(hook, input, terminal, { onStep })`. An
application credits a result to these steps, and keeps them beside it.

These spans and snapshots describe runtime provenance. Applications own
durable audit history, persistence, domain events, and payload redaction.
Runtime-generated spans include no plugin configuration, and no hook arguments
or results beyond what a hook's summary says of them.

## Develop

From the repository root:

```sh
nix develop -c pnpm core:check                # type-check
nix develop -c pnpm core:test                 # contract, lifecycle, failure, and property tests
nix develop -c pnpm package:check             # install the packed package into a temporary consumer
nix develop .#browser -c pnpm browser:check   # the same, plus a DOM consumer in Chromium
nix develop -c pnpm perf:check                # build, then core:bench, core:stress, and the others' (harness:bench…)
```

The package is private. `pnpm --filter @lemma/core pack` builds and packs it
for another application, with Effect an external dependency. Its `exports`
name a `lemma-source` condition, selecting the TypeScript sources here, which
`publishConfig.exports` leaves out, so a consumer sees only `types` and
`import`. `package:check` checks the emitted declarations, and runs a consumer
through the package export outside this workspace (provider replacement,
dependent reconstruction, cleanup, application-provided capabilities, and an
HTTP listener); its install may need network access.

The property test (`tests/sequences.test.ts`) runs random load, reload, fail,
and restart sequences against a fault-injecting fixture, and checks resource,
registration, and dependency invariants after every step.
`LEMMA_SEQUENCE_RUNS` runs more cases, and `LEMMA_SEQUENCE_SEED` fixes the
seed. A failing run prints the `LEMMA_SEQUENCE_PATH` that replays it.

`core:bench` reports warm microbenchmarks (direct Effects, hook dispatch at
several chain lengths with tracing on and off, event publishing, `core.run`
entry, mounting and disposing, reloading one plugin) as median, min, and max
batch means, not per-request percentiles. `core:stress` measures a cold
import, operation latencies, and heap and RSS over 200 mount, reload, fail,
restart, and dispose cycles after 20 warmup cycles, forcing GC every 20 and
asserting resource ownership. The packed consumers measure loopback request
p99 and throughput, and the minified browser bundle's size. These synthetic
workloads measure framework overhead, not an application's performance.

[`bench/budgets.ts`](bench/budgets.ts) holds the budgets, their reference
environment, and how each measurement is summarized. Timing budgets are
advisory (`LEMMA_PERF_ENFORCE=1` fails a miss), so measure on an idle,
comparable machine; size budgets (the browser bundle) always fail.
`LEMMA_BENCH_OUTPUT_DIR` writes the reports as JSON, each with the commit it
measured. `core:test` runs both benchmarks with tiny counts
(`LEMMA_BENCH_ITERATIONS`, `LEMMA_BENCH_SAMPLES`, `LEMMA_STRESS_CYCLES`), so
they cannot rot unnoticed. `node scripts/bench-compare.ts`, from the
repository root, compares them with a base revision's, telling a change from
noise as its doc comment says.
