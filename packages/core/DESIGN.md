# Kernel design

The core (`packages/core`) is a domain-neutral TypeScript library for composing plugins.
It supplies capabilities, hooks, events, lifetimes, and configuration. The embedding
application chooses its domain contracts, plugin sources, and composition.

Usage details live in [the package README](README.md); this page
holds the rationale and constraints.

## Principles

1. **Resolve once, at composition time.** Dependencies, config, and handler order are checked when a composition is planned. At call time a capability is a captured value and a hook with no handlers calls straight through. No proxies, no per-call graph walks, no meta-events.
2. **Typed dependencies.** A plugin declares `requires` and `provides` as Effect tags; the Layer's requirements must match at compile time, and actual exports are checked at activation. Planning rejects missing dependencies. Runtime failures can revoke capabilities, so callers must still handle the resulting failure or interruption.
3. **Three extension primitives, with explicit rules.** _Hooks_ (interceptors) wrap an operation and fail closed. _Events_ notify and are isolated. _Registries_ collect what plugins offer, owned by the plugin that offered it. See below.
4. **Failure domains.** A required background task failing stops its plugin and dependents while unrelated plugins keep running. Optional tasks and observers report faults without failing their plugin. There is no automatic restart unless the plugin declares a `restart` schedule, and that schedule persists across failures so a broken plugin can exhaust it. An explicit restart retries the named plugin and its halted dependents; forced, it also replaces a running plugin.
5. **Staged change.** Replacements activate before the old composition is swapped out. A staging failure preserves the old instances, except for exclusive resources, which require a documented interruption gap.
6. **Bounded waiting.** Activation, disposal, and the shutdown caller have cooperative deadlines. Event and diagnostic backlogs are bounded; stream delivery can lose entries. A lifecycle deadline is a fault, never a clean stop.
7. **Errors are data.** Effect's failure, defect, and interruption stay distinct. Lifecycle, observer, and background-work faults carry plugin attribution; hooks retain their error channel and tracing attribution. Ordinary capability functions are not automatically intercepted. Planning diagnostics are serializable and offer suggestions.
8. **Application-owned policy.** Plugins are trusted code with the process's permissions. Applications may implement policy through their own contracts and hooks. The kernel supplies no domain-specific approval service.

## Primitives

| Primitive       | Declared by                | Contract                                                                                                                                                                          |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability      | `Context.Service`          | A named, replaceable service. One provider per composition.                                                                                                                       |
| Plugin          | `definePlugin`             | Manifest (`id`, `config` schema, `provides`, `requires`, `exclusive`, `restart`, `deadlines`) plus a `Layer` that receives decoded config and owns resources through its `Scope`. |
| Hook            | `Hook.make`                | Around middleware on the critical path. Sequential, ordered, awaited. A handler may call `next` at most once. A handler failure fails the operation.                              |
| Event           | `Event.make`               | Notification with isolated observer failures. Bounded queue, default drop-oldest without waiting; explicit `suspend` applies backpressure.                                        |
| Registry        | `Registry.make`            | A collection plugins contribute items to (`PluginContext.add`). Ordered, attributed, staged and swapped with its contributor, removed when the contributor's scope closes.        |
| Background work | `PluginContext.background` | Supervised work owned by the plugin scope; its exit is reported. `required` work failing fails the plugin.                                                                        |
| Loader          | `makeLoader`               | Runs a composition described by data (`Composition`) and changes it at runtime.                                                                                                   |

**Rule for choosing a primitive:** an _operation_ others may change is a hook; _news_ others may react to is an event; a _thing a plugin offers_ (an entry in a list others read) is a registry item. If the caller must learn when it fails, use a hook or a direct capability call. Events carry only information that is safe to lose. Applications own authoritative state and recovery after missed notifications.

**Authoring surface.** Effect is how the kernel is built, not what every
plugin author must write. A plugin has one shape: named `requires` and
`provides`, and a `setup` that receives the one and returns the other. It is
written either with Effects (`definePlugin`'s `setup` as a generator) or with
promises (`@lemma/core/plain`), and the two differ in little more than
`function*` and `async`, so moving a plugin from one to the other is a
mechanical edit. The promise-based form is a view, not a second runtime. Its
plugins are planned, supervised, and replaced by the same code. Its services
are the same services, converted once at activation: Effect methods return
promises, streams become async iterables. Its callbacks become Effects that run
on the caller's fiber, without a promise, when they return synchronously.

What the view keeps, and how. Resources stay owned by the plugin's scope:
registrations go through its `PluginContext`, and `onCleanup` runs in its
finalizer. Cancellation reaches promise code through signals, and calls
promise code makes run in the context of the work that led to them, which is
carried across `await` by `AsyncLocalStorage` where the runtime has one. That
way a question that promise code asks while handling an operation still
belongs to that operation, and is withdrawn with it. Lifetime safety comes from refusal: once a plugin
stops, its services reject further calls, so work it leaked cannot act
through a capability. A failure nobody awaited becomes an attributed fault,
not a process-ending unhandled rejection. What it gives up is the typed error
channel at compile time (rejections are `unknown`; `fail` marks an expected
one) and structured concurrency for promises it never hands a signal. A
contract that takes callbacks accepts any of the three (`Awaitable`), and its
provider runs them with `awaitable`, so either kind of plugin can supply them.

Capability contracts remain ordinary TypeScript and can expose values,
functions, promises, or Effects. Effect supplies resource ownership,
structured concurrency, schemas, and cancellation; its role is broader than
runtime type checking. Promise-based work must honor a cancellation signal to
stop its underlying operation. No automatic wrapper can make arbitrary work
cancelable.

**Runtime choice.** The framework remains TypeScript so plugin values, callbacks,
promises, and errors stay in the same runtime as its consumers. A native core would
require a second lifetime and value model across an FFI without a demonstrated
performance benefit. Node.js is the runtime for development, tests, and server embedders
(including Electron's embedded Node); the library emits ESM JavaScript with
declarations and uses no runtime-specific APIs, so it also runs in browsers.
Workload measurements should guide any future native acceleration.

## Lifecycle

```
pending → activating → active → draining → closed
                ↘ failed ↗ (restart policy or explicit restart)
```

Plugins activate in dependency order and dispose in reverse. `draining` admits
no new work while in-flight work finishes. The [lifetime contract](README.md#lifetime-and-failure-semantics)
specifies shutdown, deadlines, and what cooperative cancellation can and cannot
stop.

## Reload

The unit of reload is the plugin instance, not the operation: replacements
start while the old instances keep serving, and in-flight work finishes on the
instance it started with. A resource that cannot exist twice (a port, a lock, a
unique name kept in a plugin's own data structure) makes its plugin
`exclusive`, stopped before its replacement starts: that gap is explicit rather
than pretending the swap was transactional. A core registry's items follow
their contributor through the swap, so a contributor to one needs no such gap.
The [loader contract](README.md#loader-and-reload) gives the
steps and what each failure leaves running.

In-memory state crosses a reload only when the plugin hands it over
(`handoff`), as a structured clone taken when its replacement starts, not as shared
mutable state. The old instance keeps serving while the new one stages, so
anything shared would be written by two instances at once. A failed instance
hands nothing over, since the failure may have left its state half updated.
The handoff is a convenience for keeping work across an edit (an application reloading
code as it is edited); it is not persistence, which stays the application's.

A change is all or nothing because it has a running composition to keep. The
first start has none, so refusing it for one failing plugin only takes away the
others: a loader may start partially, leaving that plugin failed and
inspectable, while the plugins the application marks required still start or
fail the whole start.

## Faults

Faults and diagnostics are data attributed to a plugin instance; the
[supervision contract](README.md#supervision) gives their
shapes and delivery. Deadlines wait on a daemon fiber plus a timer rather than
`Effect.timeout`, because Effect's timeout races cannot fire inside an
uninterruptible region and lifecycle bookkeeping is uninterruptible by design.
On expiry, cleanup keeps running in the background and is reported, while a
drain is abandoned and its stale work interrupted.

## Limits

Plugins are trusted, in-process code. Dependency visibility and scopes organize code; they are not a security boundary. Detached fibers, raw timers, and module-import side effects are outside the kernel's guarantees. Compositions supplied through the loader are validated when planned, so a loader-driven core is not statically typed (`Core<any>`).

## Outside the kernel

Application contracts, persistence, transports, user interfaces, package discovery,
configuration-file formats, and process bootstrap belong to consumers or their
plugins. An agent harness may supply agents, models, tools, and MCP; another
application may supply an entirely different domain. Neither defines the framework.

The core does not require a daemon, a filesystem layout, a central contract catalog,
or an application registry. A `PluginSource` maps identifiers to definitions using
the embedding application's choices. Remote proxies and untrusted-code isolation
would need explicit designs and are outside the current library's guarantees.
