# Fiber architecture

This document defines Fiber's intended architecture. It is a contract for contributors and coding
agents, not a claim that every component already exists. The current executable is the bounded,
server-rendered workspace/window and split-pane runtime documented in
[`single-pane-runtime.md`](single-pane-runtime.md) and audited in
[`current-capabilities.md`](current-capabilities.md). That output path is transitional while Fiber
moves to the checkpointed terminal-replication architecture below.

## Product goal

Fiber is an open-source, self-hosted terminal multiplexer built like infrastructure. It provides
fast, reliable, programmable sessions through a bounded, data-oriented authoritative daemon and
smart clients that use the same protocol locally and remotely. People, scripts, remote clients, and
coding agents operate one semantic model without making a hosted service part of the runtime
contract.

The daemon and each smart client form a replicated terminal system:

```text
                                      +--> smart client terminal replicas --> presentation
PTY --> ordered terminal events ------+--> smart client terminal replicas --> presentation
  |                                   +--> smart client terminal replicas --> presentation
  +--> authoritative libghostty state --> checkpoints / scrollback / effects / input modes
```

A client attaches from a bounded terminal checkpoint at sequence `N`, becomes ready, and then applies
the ordered terminal events after `N`. A checkpoint plus its event tail is the single synchronization
mechanism for local attachment, SSH attachment, reconnection, and lag recovery. The daemon does not
maintain a second long-term ANSI streaming protocol. An ANSI compatibility client consumes the same
replication protocol and renders its local replicas into an existing outer terminal; a native client
renders them directly.

The implementation remains a **modular monolith** on each side of the process boundary:

- one daemon process owns authoritative mux, process, PTY, topology, and canonical terminal state;
- each client exclusively owns its replica terminals and local presentation state;
- one engine coordinates authoritative state transitions and bounded I/O;
- hot data remains dense and locally owned;
- subsystems have explicit dependency boundaries;
- extensions communicate through commands, events, immutable values, and declarative UI models;
- components are not independent services and do not require virtual interfaces.

Agreed product decisions are recorded in [`product-contract.md`](product-contract.md), protocol
semantics in [`protocol.md`](protocol.md), and the migration sequence in
[`roadmap.md`](roadmap.md).

## Non-negotiable invariants

1. Every mutable object has exactly one owner.
2. Every queue, checkpoint, event chunk, history batch, payload, and decoder has explicit bounds.
3. Every event-loop stage has a work bound.
4. A client or extension can never block PTY progress.
5. Generational IDs are validated at trust boundaries.
6. State transitions are explicit and exhaustive.
7. Each pane's terminal events have one total order, including output, resize, reset, and exit.
8. A checkpoint at sequence `N` plus all events after `N` reconstructs the same observable terminal
   state as the authoritative daemon.
9. Only the authoritative daemon generates PTY responses and mode-dependent application input.
10. Client lag is repaired by a bounded reset/checkpoint transition, never unbounded event retention.
11. Steady-state hot paths avoid the general heap.
12. Nondeterminism is isolated so authoritative event-loop executions can be replayed.
13. Capacity exhaustion is a normal, observable, tested result.
14. Foreign-library types and private memory layouts never cross their adapter or wire boundaries.
15. Extension code never executes inside PTY parsing, event sequencing, client synchronization, or
    rendering.

Malformed external input is rejected without damaging state. Internal invariant violations use
release-enabled assertions and terminate rather than continuing with corrupt state.

## Authoritative and replica state

The daemon owns the truth:

- workspace, window, pane, and client identities;
- process and PTY lifetime;
- logical split topology, focus, zoom, ratios, and active-window state;
- canonical terminal dimensions and ordered resize decisions;
- one canonical `libghostty-vt` terminal and scrollback history per pane;
- terminal event sequence allocation;
- terminal-generated PTY responses and mode-dependent input encoding;
- permissions, controller selection, command results, and extension state.

A smart client owns expendable replicas and presentation:

- one imported terminal replica per presented pane;
- acknowledged sequence and synchronization state per pane;
- viewport, selection, search, follow-output, and local clipboard state;
- physical rectangles, native windows/tabs/splits, status, borders, overlays, and raster state;
- local keyboard/mouse decoding and Fiber-owned chrome hit testing;
- outer-terminal modes and restoration when using the ANSI presentation backend.

Replica state may be discarded at any time and reconstructed from a newer checkpoint. It is never an
authority for process lifetime, topology mutation, terminal responses, or application input modes.
Logical topology remains shared daemon state; physical presentation is client-owned.

One controlling client selects canonical PTY dimensions. Other clients render, clip, or pan that
canonical grid until control is transferred explicitly. Two clients cannot independently resize one
PTY while claiming identical terminal replicas.

## Component map

```text
apps/fiber/main -> app -----> client -----> protocol
                    |           |  |          |
                    |           |  +------> terminal adapter ---> third_party/ghostty
                    |           +---------> renderer
                    +------> daemon ---------> protocol
                               |
                               +----------> extension launcher
                               v
                         core engine <----> terminal adapter ---> third_party/ghostty
                               |
                               +--------------> platform

extension host - - - versioned typed IPC - - - core engine
client         - - checkpoint/event protocol - core engine
```

Solid arrows mean “may depend on”; cycles are forbidden. Dashed lines are protocol communication,
not C++ target dependencies.

### Core — `src/core/`

The core is the authoritative owner of mux behavior and hot daemon state. It contains the engine,
dense generational stores, commands, events, bounded queues, work budgets, terminal sequence state,
client synchronization state, and scheduling policy. Workspaces, windows, panes, clients, focus, and
logical layouts are core data—not independently allocated services.

The core assigns pane event sequence numbers, applies the same events to canonical terminals, and
retains only bounded data required by active writes and synchronization. It may orchestrate platform,
terminal, protocol, and extension interfaces. It must not know about CLI syntax, Lua stack details,
Unix socket naming conventions, client rendering algorithms, or Ghostty C types.

### Terminal adapter — `src/terminal/`

The adapter is Fiber's only boundary to `libghostty-vt`. It supports two explicit roles:

- an authoritative daemon terminal that parses PTY events, owns canonical scrollback, emits terminal
  effects/responses, encodes application input, and exports checkpoints; and
- a client replica terminal that imports checkpoints and applies ordered output/resize/reset events
  while suppressing authoritative PTY responses and policy side effects.

A checkpoint uses a bounded, versioned Fiber-owned encoding. It must not serialize private Ghostty
structs or expose Ghostty values in Fiber protocol interfaces. Checkpoint import/export must include
all state needed for deterministic continuation, including parser state at arbitrary PTY read
boundaries. Scrollback may be transferred progressively after the visible checkpoint, but the client
must know which history ranges are present.

Only adapter implementation files may include Ghostty headers. The adapter does not own PTYs,
processes, protocol sockets, topology, or presentation policy.

The pinned library does not currently expose the complete portable checkpoint API required by this
target. [`.plan/002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md)
is the mandatory feasibility gate before the replication protocol is frozen.

### Platform — `src/platform/`

Platform code wraps mechanisms Fiber actually uses: descriptor ownership, PTY creation and resizing,
child processes, Unix sockets, SSH-stdio process plumbing, signals, clocks, polling, client raw
terminal mode, and future native presentation mechanisms where required.

This is a narrow portability seam, not a framework. Platform operations return explicit values and
errors and do not mutate core or replica state themselves.

### Protocol — `src/protocol/`

The protocol component owns bounded messages between clients, the daemon, and the extension host:
message schemas, encoding, incremental decoding, limits, versions, capabilities, and handshake rules.
The generalized client protocol carries:

- typed commands, results, errors, and immutable topology values;
- terminal checkpoints and progressive history chunks;
- ordered pane output, resize, reset, and exit events;
- ready, acknowledgement, resume, reset, and resynchronization transitions; and
- ordered key, text, paste, focus, mouse, resize-request, and detach input.

The application protocol is transport-independent. Local Unix sockets and SSH stdio use the same
message semantics and bounds. Protocol code does not open sockets, discover workspaces, dispatch
commands, parse terminal bytes, or render surfaces. All lengths, enum values, versions, sequence
positions, and IDs are validated before entering authoritative or replica state.

### Renderer — `src/render/`

The target renderer is client-side. It transforms replica terminal damage plus logical topology and
client-local view state into presentation output. Backends may encode a bounded ANSI frame for an
existing outer terminal or render native surfaces directly; both consume the same replica and UI
model.

The renderer owns physical rectangle resolution, clipping, borders/status/overlays, retained
presentation state, and backend-specific output. It does not poll protocol descriptors, mutate
shared topology, parse PTY bytes, generate terminal responses, or execute extensions.

The current daemon-side ANSI compositor remains a tested migration asset. During the cutover it moves
behind the smart client and is then removed from the daemon attached-output path. A temporary second
endpoint is allowed for migration tests; two permanent daemon output architectures are not.

### Extension host — `src/extension/`

One persistent Lua host process per daemon loads trusted user configuration and extensions. It may
use normal user-level filesystem, network, process, and Lua-module capabilities without sharing the
daemon's failure domain. It registers settings, declarative key bindings, commands, event
subscriptions, and bounded UI components through a versioned, length-framed local socket.

Extensions receive stable IDs and immutable snapshots. They never receive pointers or references to
core arenas, terminal internals, daemon PTYs, or daemon sockets. The daemon processes bounded host
messages only in its deferred extension stage and never waits for Lua before PTY, input, or client
synchronization progress. Retained validated status/sidebar models are sent to clients for rendering;
Lua is not invoked during a presentation frame. A native C++ plugin ABI is explicitly out of scope.

### Application — `src/app/` and `apps/fiber/`

`apps/fiber/main.cpp` is a policy-free process bootstrap that immediately delegates to
`fiber::app::run`. The application component parses arguments, selects control-client, attached-client,
or daemon operations, and wires high-level components together. It owns no mux, terminal, or
presentation state.

### Client — `src/client/`

The target smart client owns the daemon connection, handshake, bounded replica stores, checkpoint
import, terminal event application, acknowledgement state, client-local view state, input decoding,
Fiber-owned chrome hit testing, presentation, and cleanup. It can disappear without affecting daemon
processes or canonical state.

The initial smart compatibility client may continue running inside an outer terminal and therefore
owns raw-mode lifetime and exact restoration. A native client removes that outer-terminal layer but
uses the same protocol and replica model. The current stateless byte-forwarding client is
transitional and remains documented in [`single-pane-runtime.md`](single-pane-runtime.md).

### Daemon — `src/daemon/`

The daemon component owns the per-user endpoint and lock, listener lifecycle, daemonization,
endpoint security policy, shutdown coordination, transport bootstrap, and cleanup. It lends accepted
connections to the single-owner core reactor. It does not own workspace state, canonical terminals,
protocol decoding internals, or rendering.

## Terminal synchronization model

### Ordered pane events

Every pane has one monotonically increasing event sequence. The sequence includes all mutations a
replica must apply in order:

```text
output(bytes)
resize(columns, rows, cell pixels)
reset(reason)
exit(status, reason)
```

Chunk boundaries are protocol/storage choices, not terminal semantic boundaries. Checkpoints must
therefore preserve parser continuation state or be taken only through an equally rigorous proven
mechanism; waiting indefinitely for a “safe” escape-sequence boundary is not acceptable.

### Attach

A successful attach is an explicit transaction:

1. negotiate protocol, terminal-checkpoint, input, and presentation capabilities;
2. resolve stable topology and pane IDs;
3. fence each pane at an authoritative sequence;
4. send topology plus bounded visible terminal checkpoints;
5. send `ready` only when the client can present and accept input;
6. send all subsequent ordered pane events; and
7. hydrate recent-to-oldest scrollback in bounded low-priority chunks.

New events that arrive while a checkpoint is encoded remain ordered after its fence. No output may be
lost between the checkpoint and event tail.

### Acknowledgement and lag recovery

Each client reports the highest contiguous applied sequence per pane. Event and socket queues remain
bounded. When a client exceeds its lag watermark, the daemon stops adding an unbounded tail, marks
the replica for reset, and transitions it to a fresh checkpoint after already-transmitted framed data
is handled according to the transport contract.

The client applies reset/checkpoint atomically and resumes at the checkpoint's successor sequence.
Missing scrollback is requested separately. If even bounded checkpoint progress cannot be made before
a deadline, the daemon disconnects that client without affecting the pane.

### Reconnection

A reconnecting client may request resume from a session identity and acknowledged sequences. The
daemon resumes only if every required event remains available and all versions/capabilities still
match; otherwise it sends a fresh topology/checkpoint state. Resume is an optimization, never the
only correctness path.

## Authoritative execution model

A bounded daemon reactor turn proceeds conceptually in this order:

1. collect descriptor readiness and expired deadlines;
2. read PTYs into reusable or pooled bounded chunks;
3. assign ordered pane events and make eligible output chunks available to client synchronization;
4. apply those events to canonical terminal adapters;
5. drain authoritative terminal responses into PTY write queues;
6. decode bounded client input, acknowledgements, and control messages;
7. apply a bounded batch of typed commands after canonical state has reached the required input
   order;
8. prepare bounded checkpoints, history batches, and semantic topology/UI messages;
9. flush bounded PTY and client protocol queues; and
10. dispatch a bounded batch of deferred extension work.

Exact implementation stages may combine work, but observable ordering may not change. In particular,
client display does not wait for daemon ANSI composition, while mode-dependent input never overtakes
canonical parsing of preceding output. Slow clients, checkpoint generation, history hydration, and
extensions cannot monopolize a turn.

## Input and presentation model

Keyboard and mouse are first-class inputs to one semantic system. Clients decode input and preserve
its order. Fiber-owned client presentation is hit-tested locally:

- status, borders, tabs, overlays, selection, and split handles become typed commands with stable
  targets;
- application-directed mouse values carry a validated `PaneId` and pane-local coordinates; and
- the authoritative daemon validates target, permission, bounds, and current topology before applying
  a command or encoding application input through the canonical terminal modes.

Equivalent keyboard and mouse mux actions dispatch the same core command. A configurable modifier
overrides application capture for Fiber interaction. Keyboard access remains complete.

Viewport, scrolling, search, and selection are client-local replica operations. Clipboard and OSC 52
remain explicit security boundaries. A compatibility client that enables outer-terminal keyboard,
focus, paste, mouse, synchronized-update, or alternate-screen modes must restore them on every normal,
error, signal, disconnect, and partial-startup path.

## Extension boundary

The extension contract remains command/event based:

```text
extension --typed command request--> core
extension <--immutable event value-- core
extension --bounded declarative UI--> retained daemon model --> clients
```

An extension may request an operation; the core validates IDs, permissions, payload bounds, and
current state before applying it. Event delivery may be delayed or dropped according to a documented
bounded policy, and loss is observable and repairable from a snapshot.

Extensions must not:

- retain internal pointers;
- directly mutate layouts, terminal streams, or replica state;
- access daemon-owned PTY or socket descriptors;
- invoke terminal parsing, checkpointing, synchronization, or rendering;
- make the daemon or client synchronously wait for extension work; or
- return unbounded strings, tables, surfaces, or event batches.

Trusted Lua may open its own files, sockets, and child processes. If it blocks or crashes, only the
extension host is affected; cached validated state and bounded queues preserve mux progress.

## Data and performance policy

Prefer dense arrays, generational IDs, bitsets, fixed-capacity queues, pooled immutable output slabs,
and value types over shared ownership. Avoid virtual dispatch in per-byte and per-cell loops. Share
one bounded PTY output chunk across eligible client queues rather than copying it once per client.

The primary native path is checkpoint plus raw ordered events, not daemon-generated cell diffs. A
lagging client recovers from a newer checkpoint instead of forcing indefinite raw replay. Large
checkpoints, history, and sustained output may use negotiated bounded compression; small interactive
messages are not compressed without measurement.

Optimization follows end-to-end evidence. Required measurements include key-to-PTY, key-to-visible
presentation, raw event bytes, checkpoint size/time, attach-to-ready, scrollback hydration, client
lag/resynchronization, server/client CPU, and memory across local Unix and shaped SSH transports.
The current server-rendered benchmarks remain migration baselines, not evidence that the target path
is faster.

## Build boundaries

The internal targets evolve toward:

- `fiber_base`: assertions and dependency-free foundations;
- `fiber_terminal`: the sole Ghostty adapter for authoritative and replica roles;
- `fiber_platform`: operating-system and presentation mechanisms;
- `fiber_protocol`: bounded control, checkpoint, event, history, input, and extension framing;
- `fiber_render`: client presentation backends, including the migrated ANSI compositor;
- `fiber_core`: authoritative stores, sequencing, synchronization, commands, and reactor policy;
- `fiber_extension`: full Lua configuration and the isolated extension-host process;
- `fiber_daemon`: per-user transport lifecycle and bootstrap;
- `fiber_client`: smart replica lifecycle, input, view state, and presentation coordination;
- `fiber_app`: application parsing and composition;
- `fiber`: the thin bootstrap at `apps/fiber/main.cpp`.

Targets remain cohesive rather than becoming one target per class. Ghostty headers and types must not
escape `fiber_terminal`, and checkpoint wire values remain Fiber-owned even though both daemon and
client link the private terminal dependency.

## Migration rules

- Finish and preserve the P0 server-rendered baseline before changing protocol semantics.
- Pass the terminal-checkpoint feasibility gate before freezing generalized output messages.
- Introduce authoritative IDs before checkpoint/event messages depend on pane identity.
- A temporary versioned endpoint may coexist with `fiber-v8` for tests and cutover only.
- First prove one-pane checkpoint plus event-tail equivalence, then lag recovery, then multi-pane
  client composition, then SSH transport.
- Move the existing ANSI compositor to the smart client before deleting daemon ANSI output.
- Do not maintain raw replication, cell-delta replication, and daemon ANSI as permanent modes.
- Keep structural moves separate from behavior changes where tests can distinguish them.

## Source placement rules

- A directory represents a subsystem or ownership boundary, not a class.
- Keep private headers beside their implementation under `src/`.
- Put a header under `include/fiber/` only when it is a deliberate cross-component or public API.
- Do not add empty speculative source files. Component READMEs define destinations until code is
  extracted.
- New code follows the dependency direction above; transitional coupling must be documented.
- Update [`single-pane-runtime.md`](single-pane-runtime.md) and
  [`current-capabilities.md`](current-capabilities.md) only as implemented ownership changes.

## Architectural test questions

Before accepting a change, ask:

1. Who owns every new authoritative and replica value?
2. What bounds every queue, checkpoint, event tail, history batch, payload, loop, and allocation?
3. What pane sequence orders this mutation?
4. Can checkpoint `N` plus its tail be proven equivalent to uninterrupted parsing?
5. Can a slow or malicious client delay PTY, input, or unrelated synchronization progress?
6. Can a client replica accidentally generate a PTY response or authoritative side effect?
7. Does a Ghostty/private type or memory layout escape its adapter?
8. Is presentation-local state being confused with shared topology or process state?
9. Can the operation be represented as a typed command, immutable event, or terminal-stream event?
10. How will correctness, resynchronization, capacity exhaustion, local performance, and shaped-remote
    performance be tested?
