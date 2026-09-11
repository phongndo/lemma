# Extensions

Lemma extensions are programs around the mux kernel, not code inside its hot path. The extension
system is built from three primitives:

```text
Proc      intent:      request an authoritative change
Event     fact:        observe committed state or user interaction
Surface   projection:  present extension-owned UI state
```

These primitives form one closed interaction loop:

```text
                         user
                          │
                    interacts with
                          │
                          ▼
                       Surface
                          │
                    interaction Event
                          │
                          ▼
Lemma state ── Event ──> extension ── Proc ──> Lemma state
     │                       │                       │
     └──── committed facts ──┘                       │
                             └── Surface update ──────┘
```

Extensions can observe Lemma state, present derived state, and request semantic mutations. They do
not participate in terminal parsing, command execution, scheduling, or frame production.

The same model must support small configuration helpers and large interfaces such as agent
sidebars, process dashboards, notifications, session pickers, fuzzy finders, and custom floating
terminal workflows without adding feature-specific extension APIs.

## Boundary

The daemon remains authoritative for mux and terminal state:

```text
Session -> Tab -> Pane
```

Extensions are not kernel objects. An agent, project, worktree, picker, notification center, task
runner, or dashboard exists outside the kernel and composes stable Lemma IDs through the public API.

The extension boundary is:

```text
                            EXTENSION SIDE

                      Event ────────┐
                                    ▼
                              extension state
                               │           │
                         Surface           Proc
                               │           │
                               ▼           ▼

                            LEMMA SIDE

                    retained Scene      Command executor
                          │                    │
                          ▼                    ▼
                       client           Core -> Runtime
                                             │
                                      PTY / process
                                             │
PTY output -> Ghostty terminal -> damage ----┴----> Scene composition
```

The hot path is closed. No extension code runs because:

- a PTY produced bytes;
- Ghostty reported damage;
- a frame must be composed;
- an unrelated Pane received input;
- a socket became writable;
- the scheduler needs to make progress.

A slow, blocked, or crashed extension may make its own UI stale. It must not delay unrelated input,
PTY progress, command execution, or presentation.

## Model

### Proc

A Proc is intent.

Every authoritative mutation requested by an extension uses the same bounded `lemma.proc/v1`
execution model as the CLI, agents, scripts, and other API clients. Extensions do not receive a
second mutation API and do not hold mutable Core references.

Examples include:

```text
session.start
session.rename
session.kill

tab.new
tab.select
tab.move
tab.rename
tab.kill

pane.split
pane.focus
pane.resize
pane.zoom
pane.input
pane.kill

surface.create
surface.configure
surface.focus
surface.close
```

Surface lifecycle and placement commands belong in Proc because mounting, docking, focusing, or
resizing a Surface changes authoritative Attachment presentation state and may change the space
available to Pane presentation.

A `ProcResult` answers the request that produced it. It is not an Event:

```text
extension -> Proc(surface.create) -> ProcResult(SurfaceId)
```

The result says whether that request was applied. A later Event says what committed state observers
may now see.

### Event

An Event is a fact.

Events observe committed state and never provide another mutation path. Extensions consume the same
state, process, terminal, and lifecycle facts exposed by the public observation model.

The extension event model also carries interaction facts for extension-owned Surfaces:

```text
surface.resized
surface.focused
surface.blurred
surface.closed

surface.key
surface.mouse
surface.paste
```

Surface interaction Events are routed to the owning extension rather than broadcast as general
keystroke telemetry. They use the same typed Event model but preserve ownership and input privacy.

An extension never waits for an Event to learn whether its own Proc succeeded. It reads the
`ProcResult` directly and uses Events to observe committed consequences and changes caused by other
actors.

### Surface

A Surface is projection.

A Surface contains bounded, retained presentation state owned by an extension. It is not a Session,
Tab, Pane, process, PTY, or terminal emulator.

The initial universal content primitive is a terminal-style virtual grid:

```text
Surface
└── Grid
    ├── dimensions
    ├── cells / text runs
    ├── style references
    ├── cursor state
    └── damage generation
```

An extension changes Surface content through bounded replacement or patch messages. It does not
receive a render callback and does not draw directly into an output terminal.

```text
extension
    │
SurfacePatch
    ▼
retained native Surface
    │
dirty rows / regions
    ▼
Scene compositor
    │
attached client
```

Intermediate presentation updates may be coalesced. The retained state is authoritative for that
extension projection, so dropping superseded patches never requires dropping mux state or PTY bytes.

## Scene

Every Attachment is presented through one native Scene:

```text
Attachment
└── Scene
    ├── PaneSurface
    ├── PaneSurface
    ├── ExtensionSurface
    ├── NativeSurface
    └── overlays
```

The Scene is presentation state, not a replacement for the kernel hierarchy.

A `PaneSurface` projects a real Pane and its Ghostty-owned terminal state.

An `ExtensionSurface` projects an extension-owned Grid.

A `NativeSurface` is Lemma-owned UI such as built-in command, status, message, picker, or recovery
surfaces. Native and extension Surfaces should converge on the same layout and composition
representation even when native code constructs its state without crossing an IPC boundary.

The compositor owns final ordering, clipping, borders, cursor arbitration, damage aggregation, and
terminal output. Extensions declare desired presentation; they never participate in composition.

## Placement

Surface placement is general rather than feature-specific:

```text
Placement
├── dock.left
├── dock.right
├── dock.top
├── dock.bottom
├── float
└── overlay
```

Tiled terminal Pane layout remains Core state. Extension Surfaces compose around or above that
layout rather than becoming synthetic Panes.

A docked Surface can reserve Attachment viewport space. Because that reservation can change the
effective Pane geometry, creation and placement changes use Proc:

```text
Proc(surface.create dock.right width=32)
                │
                ▼
        Scene layout resolver
                │
                ▼
      Attachment pane viewport
                │
                ▼
           Core layout
                │
                ▼
          Pane geometry
                │
                ▼
        PTY -> Ghostty resize
```

The extension declares the presentation constraint. Lemma remains the sole authority that resolves
geometry and performs dependent runtime work.

Float and overlay placement do not reserve tiled viewport space. They may be opaque or transparent;
transparent rows reveal the repaired lower Scene content wherever no run is present. Docked Surfaces
must be opaque because their reserved viewport has no Pane backing to reveal.

## Floating terminals

A terminal is always a real Pane.

Extensions do not emulate terminal semantics inside a Grid Surface. A custom floating shell,
lazygit window, build terminal, REPL, or agent terminal is created through Proc as a Pane using the
ordinary process, PTY, Ghostty, lifecycle, and input machinery.

```text
Proc -> Pane -> PaneRuntime -> PTY
          │
          └-> Ghostty terminal
                  │
                  ▼
              PaneSurface
```

The authoritative Pane remains in `Session -> Tab -> Pane`; only its presentation policy determines
whether its projection is tiled, floating, hidden, or otherwise arranged by supported native
layout semantics.

This keeps one terminal implementation and one process lifecycle regardless of how a terminal is
presented.

## Focus and input

Physical input remains native and target-directed:

```text
physical input
      │
      ▼
compiled input policy
      │
      ▼
Attachment focus target
   ┌───────┴─────────┐
   ▼                 ▼
PaneSurface    ExtensionSurface
   │                 │
   ▼                 ▼
Ghostty input    interaction Event
encoding             │
   │                 ▼
   ▼             extension
  PTY
```

Extensions do not globally intercept every key by default.

A focusable Surface receives input only while it owns Attachment focus. Mouse interaction may focus
a Surface according to native Scene policy. Programmatic focus changes use a Proc so Attachment
focus has one authoritative mutation path. `surface.mouse` columns and rows are zero-based offsets
from the Surface origin; pointer capture preserves delivery outside the Surface and reports signed
out-of-bounds offsets.

Lemma retains a native recovery path that extension UI cannot override. A malformed or unresponsive
extension must never be able to permanently trap Attachment input.

Surface-local interaction state such as a picker query, selected row, scroll position, or expanded
node normally belongs to the extension. State that changes Lemma itself uses Proc.

For a session picker:

```text
typing a query                 extension state + Surface patch
moving the selected row        extension state + Surface patch
opening or closing UI          Surface lifecycle
selecting the real Session     Proc
killing a real Session         Proc
renaming a real Session        Proc
```

## Extension loop

A normal extension is a feedback loop:

```text
              Event
                │
                ▼
         extension model
          │            │
          │            │
   SurfacePatch       Proc
          │            │
          ▼            ▼
        Scene        Lemma
          │            │
          ▼            │
         user ── Event ┘
```

For an agent sidebar:

1. Lemma publishes process, Pane, or integration Events.
2. The extension updates its private agent model.
3. The extension patches its sidebar Surface.
4. The user focuses the sidebar and presses a key.
5. Lemma routes a `surface.key` Event to the owner.
6. The extension interprets the interaction and submits a Proc.
7. Lemma validates and executes the Proc through the ordinary command executor.
8. The ProcResult answers the request.
9. Committed consequences appear through ordinary Events.
10. The extension updates its Surface again if its projection changed.

No step requires an extension-specific mutation path or a render callback.

## Scope and ownership

A Surface has a stable generational `SurfaceId` and one owner generation. In V1 every Surface is
scoped to the Attachment selected during extension admission. Attachment-scoped Surfaces are
personal presentation state:

```text
fuzzy finder
command palette
completion menu
personal agent sidebar
temporary notification
```

Shared and Session-scoped Surfaces are intentionally deferred. Focus and geometry are
Attachment-local, and each Attachment resolves Surface geometry against its own viewport.

Extension-owned resources use generation ownership:

```text
ExtensionGeneration
    ├── SurfaceId
    ├── subscriptions
    └── admitted work
```

Disconnecting or replacing the owner invalidates the generation. Lemma can then close owned
Surfaces, revoke focus, cancel owner-bound outstanding work, and release retained projection state
without executing extension cleanup code.

Borrowed pointers never cross the boundary. Stable IDs do.

## Extension session

An extension session exposes three logical flows:

```text
extension -> Lemma
    Proc
    SurfaceUpdate

Lemma -> extension
    ProcResult
    Event
```

V1 multiplexes these lanes over one full-duplex local stream connection. That connection owns one
`ExtensionGenerationId`; closing it cancels its admitted Procs and removes all of its Surfaces.
Connect to the ordinary daemon Unix socket and send the extension framing magic as the first byte.

Every record has a 16-byte network-byte-order header:

```text
0..3   magic       8a 4c 4d 45 ("LME" after the discriminator)
4      major       1
5      minor       0
6      kind        Hello=1 Welcome=2 Proc=3 ProcResult=4 SurfaceUpdate=5 Event=6 Error=7
7      flags       0
8..11  payload     unsigned JSON payload byte length
12..15 sequence    nonzero unsigned request or record ID
```

A payload is UTF-8 JSON and cannot exceed the `record_bytes` limit returned by Welcome. Unknown
versions, kinds, flags, invalid lengths, zero sequence IDs, malformed JSON, duplicate object keys,
or records sent on an ungranted capability are rejected. Reads, writes, records serviced per turn,
outstanding Procs, queued output, retained Surface bytes, rows, runs, and styles are bounded.

The first record must be Hello:

```json
{
  "schema": "lemma.extension/v1",
  "name": "project-sidebar",
  "capabilities": ["observe", "proc", "surface"],
  "events": {
    "schema": "lemma.events/v1",
    "session": {"id": "0:1"}
  }
}
```

`events.session` binds V1 Surface ownership to that Session's Attachment. Lemma replies with one
`lemma.extension-welcome/v1` record containing the generation, Attachment, granted capabilities,
and limits. If `observe` was granted, an authoritative `snapshot` Event follows before incremental
Events. Lemma retains no unbounded Event replay log.

Surface state is likewise reconstructible. Reconnection creates a new owner generation and
re-establishes desired Surfaces from extension state rather than requiring daemon-retained plugin
execution history. Structural Surface changes are ordinary `lemma.proc/v1` records. High-frequency
content uses `lemma.surface-update/v1` records with optional style-table replacement, transactional
row text runs, and cursor state; updates are validated completely before the retained Grid changes.

## Configuration and extensions

Configuration and runtime extensions serve different purposes.

Configuration defines static policy:

```text
keymaps
routing contexts
launch defaults
terminal defaults
native UI defaults
extension declarations
```

Configuration is evaluated out of the hot path and compiled into immutable native state before
ordinary operation uses it.

Runtime extensions handle dynamic behavior:

```text
observe Events
maintain private application state
submit Procs
own Surfaces
react to Surface interaction
```

The extension model must not require runtime Lua specifically. An extension may be implemented in
any language capable of speaking the versioned protocol.

Configuration may declare how trusted extensions are discovered or launched, but packaging,
distribution, and language-specific SDKs are frontend concerns rather than kernel concepts.

## Native UI

Lemma should dogfood the Surface model where practical.

Built-in UI such as status, command entry, messages, completion, pickers, and transient notices
should use the same native Scene, placement, clipping, focus, and composition machinery available
to extension Surfaces.

Native code does not need to serialize its own updates through the public protocol, but native and
extension UI should converge before composition:

```text
native UI state ───────┐
                       ├─> retained Surface -> Scene -> compositor
extension SurfacePatch ┘
```

There must not be one compositor for built-in UI and a second compositor for plugin UI.

Native UI may retain privileged recovery or security surfaces that extensions cannot replace.

## Performance and backpressure

Extension capability must not scale the ordinary terminal hot path.

With no active Surface damage or extension Events, installed idle extensions should add no
per-byte, per-cell, or per-frame work beyond bounded connection bookkeeping.

The implementation should preserve these properties:

- PTY bytes are parsed exactly once into the Pane's canonical Ghostty terminal.
- Extension code never runs on PTY, input-routing, or composition stacks.
- Surface content is retained so unchanged UI creates no extension work.
- Surface updates mark bounded dirty regions rather than forcing full Scene redraws.
- Multiple pending patches to the same Surface may be coalesced when intermediate states are not
  externally observable.
- Slow extension readers cannot block unrelated Proc execution, PTY progress, or Attachments.
- Slow Surface writers cannot grow daemon memory without bound.
- Hidden or fully occluded Surfaces do not require composition work until they can affect output.
- A Surface update storm may make that Surface stale, be coalesced, or disconnect its owner; it
  must not create unbounded scheduler work.
- Extension resource limits are explicit and observable.

Performance tests should include:

```text
zero extensions vs many installed idle extensions
idle Surface vs rapidly updating Surface
slow Event consumer
slow Surface producer
extension crash while focused
extension crash while docked
extension update storm beside interactive Pane input
many Surfaces with most hidden or unchanged
```

A key acceptance criterion is that a hung extension has no measurable effect on unrelated PTY
progress and that many idle extensions do not materially change interactive latency.

## Failure

Extension failure is local.

If an extension crashes, times out, violates protocol bounds, or disconnects:

- its owner generation is invalidated;
- its extension-owned Surfaces are removed;
- Surface focus is revoked using native fallback policy;
- owner-bound outstanding work is canceled according to ordinary Proc semantics;
- native UI remains available;
- Sessions, Tabs, Panes, PTYs, and terminal state continue;
- unrelated extensions continue;
- no extension callback is required for cleanup.

A malformed Surface update is rejected without corrupting retained Scene state. Surface updates are
transactional at the record boundary: either a validated update becomes visible or the previous
valid projection remains.

A failed extension cannot leave Core in a partially published lifecycle transition because
extensions never execute inside those transitions.

## Capability and trust

Extensions execute outside the mux kernel but may still act with the user's authority.

Protocol admission makes requested capabilities explicit. V1 negotiates exactly:

```text
observe     subscribe to selected Events, snapshots, and bounded screen projections
proc        submit Proc records
surface     create and update Surfaces and receive their scoped interaction Events
```

Exact permission UX may evolve independently of this wire-level capability split.

Surface interaction is ownership-scoped. An extension does not receive arbitrary user keystrokes
merely because it is connected.

Operating-system sandboxing is not implied by protocol isolation. User-installed code should be
treated as trusted unless Lemma explicitly provides a stronger sandbox.

## Versioning and discovery

The extension contract is versioned and discoverable.

The installed binary should be able to describe:

```text
Proc schema
Event schema
Surface schema
supported Surface placements
supported style and input capabilities
resource bounds
protocol versions
```

Extensions must negotiate or declare a compatible protocol version before creating state.

New Event variants and Surface capabilities should preserve the three-primitive model rather than
adding feature-specific callback systems. A new capability is justified when it cannot be expressed
cleanly as:

```text
observe a fact
project a view
request an intent
```

## Non-goals

The extension system does not provide:

- arbitrary code execution inside the daemon reactor;
- callbacks during PTY parsing;
- callbacks during Ghostty mutation;
- callbacks during frame composition;
- per-cell render hooks;
- synchronous interception of unrelated input;
- direct mutable access to Core objects;
- extension-owned PTYs outside the ordinary Pane lifecycle;
- a second terminal emulator for plugin terminals;
- unbounded event or frame replay;
- feature-specific APIs for agent sidebars, pickers, notifications, dashboards, or similar UI.

Those experiences should emerge from the generic primitives.

## Invariants

1. `Proc = intent`, `Event = fact`, and `Surface = projection`.
2. Every authoritative Lemma mutation requested by an extension uses Proc and receives a typed
   result.
3. Events observe committed state or scoped user interaction and never mutate state.
4. A Surface is presentation state and never becomes a Session, Tab, Pane, PTY, or terminal truth.
5. The daemon remains the sole authority for mux state, Attachment focus, geometry, and Pane
   terminal truth.
6. Extensions declare Surface presentation; the native Scene resolver and compositor own geometry,
   clipping, ordering, damage, and output.
7. A terminal shown by an extension is still a real Pane using the ordinary PTY and Ghostty path.
8. Extension code never runs because a PTY produced bytes, a frame must render, or unrelated input
   arrived.
9. Extension input is target-directed to focused owned Surfaces rather than globally intercepted.
10. Native and extension UI converge on one retained Scene and one compositor.
11. Surface, Event, Proc, queue, payload, update, and retained-state work is explicitly bounded.
12. Slow or malformed extensions cannot prevent unrelated PTY, command, or presentation progress.
13. Extension ownership is generational; disconnect can clean up without executing extension code.
14. Visible extension state is reconstructible from extension state plus authoritative Lemma
   snapshots; Lemma retains no unbounded plugin execution history.
15. New extension features should first be expressible by composing Proc, Event, and Surface before
   adding another primitive.
