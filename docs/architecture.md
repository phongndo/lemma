# Fiber architecture

This document defines Fiber's intended architecture. It is a contract for contributors and coding
agents, not a claim that every component already exists. The current executable is a bounded
workspace/window and split-pane runtime documented in [`single-pane-runtime.md`](single-pane-runtime.md).

## Product goal

Fiber is an open-source, self-hosted terminal multiplexer built like infrastructure. It provides
fast, reliable, programmable sessions through a bounded, data-oriented core and an extension
boundary that does not compromise latency, ownership, or memory safety. The same typed semantic
model is intended for people, scripts, remote clients, and coding agents without making a hosted
service part of the runtime contract. Agreed foundation decisions and still-open product questions
are recorded in [`product-contract.md`](product-contract.md).

The design is a **modular monolith**:

- one process owns the authoritative mux state;
- one engine coordinates state transitions and I/O;
- hot data remains dense and locally owned;
- subsystems have explicit dependency boundaries;
- extensions communicate through commands, events, and immutable values;
- components are not independent services and do not require virtual interfaces.

The architecture deliberately avoids both a giant implementation file and a graph of tiny service
objects.

## Non-negotiable invariants

1. Every mutable object has exactly one owner.
2. Every queue has byte and element bounds.
3. Every event-loop stage has a work bound.
4. A client or extension can never block PTY progress.
5. Generational IDs are validated at trust boundaries.
6. State transitions are explicit and exhaustive.
7. Rendering visits only affected clients and rows.
8. Steady-state hot paths avoid the general heap.
9. Nondeterminism is isolated so event-loop executions can be replayed.
10. Capacity exhaustion is a normal, observable, tested result.
11. Foreign-library types never cross their adapter boundary.
12. Extension code never executes inside PTY parsing, composition, or output encoding.

Malformed external input is rejected without damaging state. Internal invariant violations use
release-enabled assertions and terminate rather than continuing with corrupt state.

## Component map

```text
apps/fiber/main -> app -----> client -----> protocol
                    |           |             |
                    +------> daemon -----------+
                               |   |
                               |   +----------> extension launcher
                               v
                         core engine <----> terminal adapter ---> third_party/ghostty
                               |   |
                               |   +----------> renderer
                               +--------------> platform

extension host - - - versioned typed IPC - - - core engine
```

Solid arrows mean “may depend on”; cycles are forbidden. The dashed process boundary is protocol
communication, not a C++ target dependency.

### Core — `src/core/`

The core is the authoritative owner of mux behavior and hot state. It will contain the engine,
dense state stores, IDs, commands, events, bounded queues, work budgets, and scheduling policy.
Workspaces, tasks, runs, views, clients, focus, and layouts are core data—not independently
allocated services.

The core may orchestrate platform, terminal, protocol, and rendering operations. It must not know
about CLI syntax, Lua stack details, Unix socket path conventions, or Ghostty C types.

### Terminal adapter — `src/terminal/`

The adapter is Fiber's only boundary to `libghostty-vt`. Each pane owns one adapter instance as its
canonical emulated terminal state.

Ghostty owns VT parsing, screen state, scrollback, reflow, grapheme/cell semantics, terminal modes,
application input encoding, terminal query responses, and dirty terminal-state tracking. Fiber owns
PTYs, process lifecycle, pane layout, multi-pane composition, client viewports, and outer-terminal
output.

Only the adapter implementation may include Ghostty headers. Its interface uses Fiber-owned values
and opaque ownership. `libghostty-vt` is a private implementation dependency: it is not part of
Fiber's API and must not be linked or included directly by other components.

The adapter implementation lives in `src/terminal/terminal.cpp`; its cross-component Fiber value
interface lives in `include/fiber/terminal/terminal.hpp`.

### Platform — `src/platform/`

Platform code wraps the operating-system mechanisms Fiber actually uses: descriptor ownership,
PTY creation and resizing, child processes, Unix sockets, signals, clocks, polling, and client raw
terminal mode.

This is a narrow portability seam, not a framework. Avoid abstractions for hypothetical platforms.
Platform operations return explicit values/errors and do not mutate core state themselves.

### Protocol — `src/protocol/`

The protocol component owns bounded messages between the disposable client, extension host, and
daemon: message schemas, encoding, incremental decoding, payload limits, and handshake rules. The
current client wire format and versioned extension framing are documented in
[`protocol.md`](protocol.md). Decoded mutating client actions are translated into the shared C++
command model before they change mux state; protocol code does not open sockets, discover
workspaces, dispatch core commands, or write terminal bytes.

All lengths and enum values are validated before a message reaches the core.

### Renderer — `src/render/`

The renderer transforms terminal damage plus mux layout and client state into bounded output frames.
It resolves pane rectangles, clips viewports, composes borders/status/overlays, diffs against each
client's retained physical state, and encodes outer-terminal bytes.

Rendering is synchronous, deterministic, and extension-free. It does not poll descriptors, write to
sockets, mutate topology, or parse application VT streams.

### Extension host — `src/extension/`

One persistent Lua host process per daemon loads trusted user configuration and extensions. It may
use normal user-level filesystem, network, process, and Lua-module capabilities without sharing the
daemon's failure domain. It registers settings, declarative key bindings, commands, event
subscriptions, and bounded UI components through a versioned, length-framed local socket.

Extensions receive stable IDs and immutable snapshots. They never receive pointers or references to
core arenas, terminal internals, daemon PTYs, or daemon sockets. The daemon processes bounded host
messages only in its deferred extension stage and never waits for Lua before PTY or frame progress.
Rendered UI uses retained validated surfaces rather than synchronous Lua callbacks. A native C++
plugin ABI is explicitly out of scope.

### Application — `src/app/` and `apps/fiber/`

`apps/fiber/main.cpp` is a policy-free process bootstrap that immediately delegates to
`fiber::app::run`. The application component parses process arguments, selects client or daemon
operations, and wires high-level components together. It owns no mux state or I/O mechanism.

### Client — `src/client/`

The disposable client owns raw-terminal lifetime, local keyboard and mouse decoding, prefix
handling, resize/focus forwarding, the daemon connection, outer-terminal writes, and exact terminal
restoration. It normalizes identifiable interactions into bounded protocol values but owns no layout
or hit-testing policy. It can disappear without affecting daemon-owned workspace state.

### Daemon — `src/daemon/`

The daemon component owns the per-user endpoint and lock, listener lifecycle, daemonization,
endpoint security policy, shutdown coordination, and cleanup. It lends the listener to the
single-owner core reactor, which owns all workspaces, accepts ready connections, and translates
validated protocol messages into state transitions. The daemon does not own workspace state or
become a second core engine.

## Core execution model

A bounded reactor turn proceeds in this order:

1. collect descriptor readiness and expired deadlines;
2. read PTYs into reusable bounded storage;
3. feed bounded byte batches to terminal adapters;
4. drain terminal responses into PTY write queues;
5. decode bounded client input and control messages;
6. apply a bounded batch of typed commands;
7. collect dirty pane and affected-client IDs;
8. compose and encode due client frames;
9. flush bounded PTY and client output queues; and
10. dispatch a bounded batch of deferred extension events.

Ordering is part of the architecture. In particular, extension work occurs after latency-sensitive
PTY and rendering work. Fairness budgets prevent one busy pane or slow client from monopolizing a
turn. `include/fiber/command.hpp` defines the allocation-free command value, target IDs, origin, typed
result, and validating dispatcher. The engine owns the sole executor that translates validated
commands into workspace/window/pane mutations.

## Input model

Keyboard and mouse are first-class inputs to one semantic system. The client is responsible for
bounded decoding and preserving event order; the core owns active-client policy, layout hit testing,
focus, selection, and dispatch. A mouse event carries a closed action/button enum, bounded modifier
bits, client-cell coordinates, and bounded wheel motion. The core either translates it into the same
command used by a keyboard binding or targets a pane and converts the coordinates to pane-local
cells. Application-directed key and mouse values are then encoded through the terminal adapter using
the pane's canonical modes rather than being blindly forwarded.

Fiber-owned rows, separators, overlays, and selection remain mux input targets even when an
application has enabled mouse tracking. An explicit configurable modifier overrides application
capture. Keyboard access must remain complete for all core operations, while pointer-specific
interactions such as direct hit testing and drag resizing operate on the same layout mutations as
their keyboard equivalents.

Outer-terminal mode ownership remains with the disposable client. Enabling mouse tracking, focus
reporting, paste modes, or alternate-screen behavior creates a restoration obligation on normal
exit, protocol failure, signal handling, daemon disconnect, and partial startup failure. Input queues,
decoder storage, per-turn input work, and drag/wheel coalescing are bounded. The current byte-stream
client is transitional; [`protocol.md`](protocol.md) defines the required protocol evolution.

## Extension boundary

The extension contract is command/event based:

```text
extension --typed command request--> core
extension <--immutable event value-- core
```

Allowed extension capabilities are explicit. An extension may request an operation; the core
validates IDs, permissions, payload bounds, and current state before applying it. Event delivery may
be delayed or dropped according to a documented bounded policy.

Extensions must not:

- retain internal pointers;
- directly mutate layouts or pane state;
- access daemon-owned PTY or socket descriptors;
- invoke terminal parsing or rendering;
- make the daemon synchronously wait for extension work; or
- return unbounded strings, tables, surfaces, or event batches.

Trusted Lua may open its own files, sockets, and child processes. If it blocks or crashes, only the
extension host is affected; bounded queues and cached daemon state preserve mux progress.

This boundary preserves the freedom to change core storage and scheduling without breaking the
extension API.

## Data and performance policy

Prefer dense arrays, generational IDs, bitsets, fixed-capacity queues, and pooled slabs in hot state.
Prefer value types over shared ownership. Avoid virtual dispatch in per-byte and per-cell loops.
Batch system calls and preserve damage information rather than scanning all panes or clients.

Optimization follows measurement. Every important optimization should have a benchmark or trace,
and architectural complexity requires end-to-end evidence—not only a microbenchmark.

## Build boundaries

The current internal targets enforce component boundaries:

- `fiber_base`: assertions and dependency-free foundations;
- `fiber_terminal`: the sole Ghostty adapter and private Ghostty dependency;
- `fiber_platform`: operating-system mechanisms;
- `fiber_protocol`: bounded wire encoding and decoding;
- `fiber_render`: retained outer-terminal frame generation;
- `fiber_core`: authoritative engine-facing API as it is introduced;
- `fiber_extension`: full Lua configuration and the isolated extension-host process;
- `fiber_daemon`: per-user transport and daemon lifecycle;
- `fiber_client`: disposable attached-terminal behavior;
- `fiber_app`: application parsing and composition;
- `fiber`: the thin bootstrap at `apps/fiber/main.cpp`.

Targets should remain cohesive rather than becoming one target per class. Ghostty headers and types
must not escape `fiber_terminal`, even though static-link mechanics propagate its final archive link
requirement.

## Source placement rules

- A directory represents a subsystem or ownership boundary, not a class.
- Keep private headers beside their implementation under `src/`.
- Put a header under `include/fiber/` only when it is a deliberate cross-component or public API.
- Do not add empty speculative source files. The directory READMEs define destinations until code is
  extracted.
- New code must follow the established dependency direction; transitional coupling must be documented.
- Structural refactors must preserve behavior and should be separated from feature changes.

## Architectural test questions

Before accepting a change, ask:

1. Who owns every new mutable value?
2. What bounds every new queue, payload, loop, and allocation?
3. Can a slow client or extension delay PTY progress?
4. Does a foreign or private type escape its component?
5. Does this add work proportional to all panes/clients on a local change?
6. Can the operation be represented as a typed command or immutable event?
7. Is this abstraction required now, or is it speculative?
8. How will correctness, capacity exhaustion, and performance be tested?
