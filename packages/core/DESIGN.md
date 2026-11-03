# Kernel design

The core (`packages/core`) is a domain-neutral TypeScript library for composing
plugins. It supplies capabilities, hooks, events, lifetimes, and configuration.
The embedding application chooses its domain contracts, plugin sources, and
composition, and provides the capabilities its plugins are written against; a
plugin's requirement is met by another plugin or by the application.

Usage details live in [the package README](README.md); this page
holds the rationale and constraints.

## Principles

1. **Resolve once, at composition time.** Dependencies, config, and handler
   order are checked when a composition is planned. At call time a capability is
   a captured value and a hook with no handlers calls straight through. No
   proxies, no per-call graph walks, no meta-events.
2. **Typed dependencies.** A plugin declares `requires` and `provides` as Effect
   tags; the Layer's requirements must match at compile time, and actual exports
   are checked at activation. Each requirement is met by a plugin or by the
   application, and planning rejects one that neither meets. The manifest exists
   because Effect's type-level requirements alone cannot describe a composition
   supplied at run time; construction and cleanup still belong to Effect, not to
   a second dependency-injection system. Runtime failures can revoke plugins'
   capabilities, so callers must still handle the resulting failure or
   interruption.
3. **Three extension primitives, with explicit rules.** _Hooks_ (interceptors)
   wrap an operation and fail closed. _Events_ notify and are isolated.
   _Registries_ collect what plugins offer, owned by the plugin that offered it.
   See below.
4. **Failure domains.** A required background task failing stops its plugin and
   dependents while unrelated plugins keep running. Optional tasks and observers
   report faults without failing their plugin. A failed plugin stays failed
   until an explicit restart, which retries the named plugin and its halted
   dependents; forced, it also replaces a running plugin.
5. **Staged change.** Replacements activate before the old composition is
   swapped out. A staging failure preserves the old instances, except for
   exclusive resources, which require a documented interruption gap.
6. **Bounded waiting.** Activation, disposal, and the shutdown caller have
   cooperative deadlines. Event and diagnostic backlogs are bounded; stream
   delivery can lose entries. A lifecycle deadline is a fault, never a clean
   stop.
7. **Errors are data.** Effect's failure, defect, and interruption stay
   distinct. Lifecycle, observer, and background-work faults carry plugin
   attribution; hooks retain their error channel and tracing attribution.
   Ordinary capability functions are not automatically intercepted. Planning
   diagnostics are serializable and offer suggestions.
8. **Application-owned policy.** Plugins are trusted code with the process's
   permissions. Applications may implement policy through their own contracts
   and hooks. The kernel supplies no domain-specific approval service.

## Primitives

| Primitive       | Declared by                | Contract                                                                                                                                                                                                                    |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability      | `Context.Service`          | A named service. One provider per composition: a plugin, which can be replaced, or the application.                                                                                                                         |
| Plugin          | `definePlugin`             | Manifest (`id`, `config` schema, `provides`, `requires`, `exclusive`, `deadlines`) plus a `Layer` that receives decoded config and owns resources through its `Scope`.                                                      |
| Hook            | `Hook.make`                | Around middleware on the critical path. Sequential, ordered, awaited. A handler may call `next` at most once. A handler failure fails the operation.                                                                        |
| Event           | `Event.make`               | Notification with isolated observer failures. Bounded queue, default drop-oldest without waiting; explicit `suspend` applies backpressure.                                                                                  |
| Registry        | `Registry.make`            | A collection plugins contribute items to (`PluginContext.add`). Ordered, attributed, staged and swapped with its contributor, removed when the contributor's scope closes; work with an item (`Registries.run`) ends first. |
| Background work | `PluginContext.background` | Supervised work owned by the plugin scope; its exit is reported. `required` work failing fails the plugin.                                                                                                                  |
| Loader          | `makeLoader`               | Runs a composition described by data (`Composition`) and changes it at runtime.                                                                                                                                             |

**Rule for choosing a primitive:** an _operation_ others may change is a hook;
_news_ others may react to is an event; a _thing a plugin offers_ (an entry in a
list others read) is a registry item. If the caller must learn when it fails,
use a hook or a direct capability call. Events carry only information that is
safe to lose. Applications own authoritative state and recovery after missed
notifications.

**Authoring surface.** Effect is how the kernel is built, not what every
plugin author must write. A plugin has one shape, written either with Effects
or with promises (`@lemma/core/plain`), and the two differ in little more than
`function*` and `async`, so moving a plugin from one to the other is a
mechanical edit. The promise-based form is a view, not a second runtime: its
plugins are planned, supervised, and replaced by the same code, and its
services are the same services, converted once at activation
([the mapping](README.md#plugins-written-with-promises)).

What the view keeps, and how. Resources stay owned by the plugin's scope.
Calls promise code makes run in the context of the work that led to them, so a
question it asks while handling an operation still belongs to that operation,
and is withdrawn with it. Lifetime safety comes from refusal: a stopped
plugin's services reject further calls, so work it leaked cannot act through a
capability. What it gives up is the typed error channel at compile time
(rejections are `unknown`; `fail` marks an expected one) and structured
concurrency for promises it never hands a signal. A contract that takes
callbacks accepts any of the three (`Awaitable`), so either kind of plugin can
supply them.

Effect supplies resource ownership, structured concurrency, schemas, and
cancellation; its role is broader than runtime type checking. No automatic
wrapper can make arbitrary work cancelable, which is why promise-based work
must honor a cancellation signal itself.

**Runtime choice.** The framework remains TypeScript so plugin values,
callbacks, promises, and errors stay in the same runtime as its consumers. A
native core would require a second lifetime and value model across an FFI
without a demonstrated performance benefit. Node.js is the runtime for
development, tests, and server embedders (including Electron's embedded Node);
the library emits ESM JavaScript with declarations and uses no runtime-specific
APIs, so it also runs in browsers. Workload measurements should guide any future
native acceleration.

## Lifecycle

```
pending → activating → active → draining → closed
                ↘ failed ↗ (explicit restart)
```

Plugins activate in dependency order and dispose in reverse. The application's
capabilities come before the first plugin and outlive the last: they have no
lifecycle of their own while the core runs. `draining` admits no new work while
in-flight work finishes. The [lifetime
contract](README.md#lifetime-and-failure-semantics) specifies shutdown,
deadlines, and what cooperative cancellation can and cannot stop.

## Reload

The unit of reload is the plugin instance, not the operation: replacements
start while the old instances keep serving, and in-flight work finishes on the
instance it started with. A resource that cannot exist twice (a port, a lock, a
unique name kept in a plugin's own data structure) makes its plugin
`exclusive`, stopped before its replacement starts: that gap is explicit rather
than pretending the swap was transactional. A core registry's items follow
their contributor through the swap, so a contributor to one needs no such gap.

Work a reader runs with an item belongs to the item's contributor
(`Registries.run`), so it may finish on the retired instance, as in-flight
`core.run` work does, but never runs once its finalizers have begun. It knows
whose it is (`Admitted`), so a change it asks for that would replace its own
plugin can wait for it to end, rather than the disposal waiting on the work
that waits on the disposal. Changes run one at a time, so a reader whose work
an item's leaving ended can wait for the change under way (`Registries.settled`)
rather than guess how long a replacement takes to start. The
[loader contract](README.md#loader-and-reload) gives the steps and what each
failure leaves running.

No in-memory state crosses a reload, because the old instance keeps serving
while the new one stages: state the two shared would be written by both at
once. Persistence stays the application's.

A change is all or nothing because it has a running composition to keep. The
first start has none, so refusing it for one failing plugin only takes away the
others. That is why a loader may start partially (`partialStart`), while the
plugins the application marks required still start or fail the whole start.

## Faults

Faults and diagnostics are data attributed to a plugin instance; the
[supervision contract](README.md#supervision) gives their shapes and delivery.
Deadlines wait on a daemon fiber plus a timer rather than `Effect.timeout`,
because Effect's timeout races cannot fire inside an uninterruptible region and
lifecycle bookkeeping is uninterruptible by design. The daemon fiber is also
what lets cleanup go on, and be reported, past its deadline.

To drain only the `core.run` tasks that resolved what a failure revokes, and
revoke it from them, the core watches the map each task's context is made from
(`internal/tracked.ts`). Effect has no API to observe a service lookup, so
this depends on how Effect's `Context` holds that map: it resolves services
through the map's `get`, and iterates the map before it stops using it.
`tests/tracked.test.ts` checks that against the installed Effect, so an
upgrade that changes it fails there rather than leaving tasks undrained.

## Limits

Plugins are trusted, in-process code. Dependency visibility and scopes organize
code; they are not a security boundary. Compositions supplied through the loader
are validated when planned, so a loader-driven core is not statically typed
(`Core<any>`).

## The application's capabilities

What every plugin may assume, such as the connection to a host or a way to ask
the user, is the application's to provide
([`provide`](README.md#capabilities-the-application-provides)). Written as
plugins, these were plugins the application could never let be turned off,
which forced it to keep everything they required as well.

They are fixed for the life of the core. Nearly every plugin requires some
runtime capability, so replacing one would restart nearly everything, which is
a new core rather than a reload; and a replaceable one would need staging,
draining, and `haltedBy`, the lifecycle that makes something a plugin.

Their layer has no `PluginContext`, because a runtime piece uses extension
points (it invokes a hook plugins handle, reads a registry), which takes no
owner. An owner brings an id, attributed faults, a scope a reload swaps, and a
row in `inspect`: all that the application's services are not.

A plugin cannot override one (`ReservedCapability`). The composition has no
last-writer-wins anywhere, and an override would let one plugin change, unseen,
what the application and every other plugin rely on. Which runtime the plugins
get is the application's decision, made where it provides it.

## Outside the kernel

Application contracts, persistence, transports, user interfaces, package
discovery, configuration-file formats, and process bootstrap belong to consumers
or their plugins. An agent harness may supply agents, models, tools, and MCP;
another application may supply an entirely different domain. Neither defines the
framework.

The core does not require a daemon, a filesystem layout, a central contract
catalog, or an application registry. A `PluginSource` maps identifiers to
definitions using the embedding application's choices. Remote proxies and
untrusted-code isolation would need explicit designs and are outside the current
library's guarantees.
