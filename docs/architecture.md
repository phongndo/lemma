# Lemma architecture

## Decision

Lemma is an authoritative, server-rendered terminal multiplexer. One per-user daemon owns every PTY,
canonical terminal, mux mutation, attachment view, and presentation decision. Thin clients decode
physical input, exchange bounded typed messages with the daemon, write daemon-produced ANSI frames,
and restore their outer terminal exactly.

This is the production direction through 1.0. Lemma does not require client terminal replicas,
portable terminal checkpoints, or client-side VT parsing. The retained
[`terminal-checkpoint-feasibility.md`](terminal-checkpoint-feasibility.md) evidence proves that the
pinned Ghostty API cannot support deterministic checkpoint continuation, so the smart-replica design
was rejected in favor of server-rendered authority.

The current implementation already follows the essential ownership model. Its unversioned protocol,
input surface, daily-driver UX, configuration integration, remote validation, and release engineering
remain incomplete; implemented behavior is audited in
[`current-capabilities.md`](current-capabilities.md).

## Product goal

Lemma is an open-source, self-hosted terminal multiplexer built like infrastructure: fast, reliable,
and programmable without a hosted service. People, scripts, remote shells, Lua extensions, and AI
agents operate one semantic command model while the latency-sensitive PTY and rendering path
remains bounded and independently operable.

```text
                                 typed commands / input
thin terminal client --------------------------------------------+
       ^                                                         |
       | bounded ANSI frames / effects                           v
       +---------------------- daemon reactor and core engine ----+
                                      |       |          |
                                      |       |          +--> isolated Lua host
                                      |       +--> layout / compositor
                                      +--> PTYs / canonical Ghostty terminals
```

The architecture is a modular monolith around one daemon reactor, not a collection of services:

- one daemon process owns authoritative mux, process, terminal, attachment, and render state;
- one engine coordinates state transitions and bounded I/O;
- hot data remains dense and locally owned;
- subsystem dependencies are explicit and acyclic; and
- extensions communicate through commands, immutable values, events, and declarative UI models.

## Non-negotiable invariants

1. Every mutable object has exactly one owner.
2. Every queue, frame, decoder, payload, batch, allocation, and per-turn loop has an explicit bound.
3. A client or extension can never block PTY progress or end pane processes by failing.
4. Generational IDs are validated at every trust boundary.
5. State transitions are explicit and exhaustive.
6. PTY output, terminal responses, and accepted application input preserve their required order.
7. Only the daemon parses PTY output, generates PTY responses, and encodes mode-dependent input.
8. Attach, tab changes, resize, and presentation recovery reconstruct visible state from canonical
   daemon state; no replay log is required for correctness.
9. Client lag is repaired by a bounded full redraw or disconnect, never an unbounded output queue.
10. Steady-state terminal parsing and damage rendering avoid the general heap.
11. Nondeterminism is isolated so authoritative engine traces can be reproduced.
12. Capacity exhaustion is a normal, observable, tested result.
13. Foreign-library types and private layouts never cross their adapter boundary.
14. Extension code never executes in PTY parsing, input ordering, rendering, or descriptor progress.
15. Every outer-terminal mode enabled by a client has a complete restoration path.

Malformed external input is rejected without partial authoritative mutation. Internal invariant
violations use release-enabled assertions and terminate rather than continuing with corrupt state.

## Ownership

### Daemon authority

The daemon owns:

- session, tab, pane, connection, and attachment identities;
- child-process and PTY lifetime;
- logical split topology, resolved presentation rectangles, focus, zoom, ratios, and active tabs;
- canonical terminal dimensions, Ghostty state, scrollback, effects, and input modes;
- per-attachment prefix state, viewport, copy/search/selection state, and presentation cache;
- command validation, application-input encoding, and terminal-generated PTY responses;
- bounded ANSI frame construction, queueing, redraw state, and lag policy;
- extension registrations, validated retained UI models, and configuration generations; and
- permissions and controller policy if multiple attachments are added later.

The current one-client-per-session rule keeps dimension and presentation ownership unambiguous.
Future viewers require separate daemon-owned attachment state and an explicit controlling client;
they do not require terminal replicas.

### Thin client

An attached client owns only expendable transport and outer-terminal state:

- daemon connection and protocol decoder;
- physical keyboard, paste, focus, resize, and mouse decoding;
- local termios, signal integration, and enabled outer-terminal modes;
- a bounded output queue while writing daemon-produced ANSI; and
- exact cleanup on normal, failure, signal, disconnect, and partial-startup paths.

A client does not own a terminal emulator, mux topology, command authority, or canonical scrollback.
It can disappear at any time without affecting pane processes.

## Component map

```text
apps/lemma/main -> app -----> client --------> protocol
                    |           |                 |
                    |           +------------> platform
                    +------> daemon ----------> protocol
                               |
                               +----------> extension launcher
                               v
                         core engine <------> renderer
                           |      |
                           |      +----------> terminal adapter ---> third_party/ghostty
                           +-----------------> platform

extension host - - - versioned typed IPC - - - core engine
client         - - - versioned attach IPC - - core engine
```

Solid arrows mean “may depend on”; cycles are forbidden. Dashed lines are protocol communication,
not C++ target dependencies.

### Core — `src/core/`

The core is the sole authoritative mux owner. Its canonical ownership hierarchy is
`Session → Tab → Pane`. It contains bounded generational stores/owner-local slots, typed commands and
bounded command traces, queues, scheduling policy, immutable session launch context, attachment
state, and the daemon reactor. Sessions, tabs, panes, clients, focus,
layouts, viewports, and copy state are core data—not independently allocated services. Spaces,
workspaces, projects, worktrees, tasks, and agent runs are extension policy expressed through stable
IDs, metadata, commands, events, and retained views rather than additional core containers.

The core may orchestrate platform, terminal, protocol, renderer, and extension interfaces. It must
not know CLI syntax, Lua stack details, Unix socket naming conventions, or Ghostty C types.

### Terminal adapter — `src/terminal/`

The adapter is Lemma's only boundary to `libghostty-vt`. Every live pane has one daemon-owned
terminal. The adapter:

- parses PTY bytes and owns canonical screen/scrollback state;
- exposes bounded Lemma-owned cells, damage, modes, title, cursor, and effects;
- captures terminal-generated responses for the pane's ordered PTY write queue;
- encodes application input from canonical modes; and
- supports complete visible-state and damage formatting for the compositor.

It does not export production checkpoints and does not support a replica role. Ghostty headers,
pointers, allocator identities, private enum values, and layouts never leave the implementation.
The pinned Ghostty scrollback option is exposed as bytes because its implementation applies a byte
limit despite the C header naming lines.

### Renderer — `src/render/`

The renderer converts canonical terminal damage, topology, status, overlays, and per-attachment view
state into bounded ANSI frames. It owns retained physical-frame state, clipping, separators, cursor,
outer-terminal modes, full-redraw invalidation, and frame encoding. It performs no socket I/O and
does not mutate topology or terminal state.

A later native renderer may consume bounded Lemma-owned presentation snapshots and deltas derived
from canonical daemon state. Such values are replaceable presentation state—not VT input, parser
state, or a second terminal authority. Native presentation is not a 1.0 requirement.

### Protocol — `src/protocol/`

The private production attach protocol is bounded and bidirectional. It carries hello/mismatch,
attach/control, ordered physical input/commands, bounded ANSI render frames, full-redraw epochs, and
typed client effects. It is version-coupled to the binary and is not the public automation API.

One shared semantic model separately defines stable IDs, actors, commands, results/errors,
capabilities, snapshots, events, launch/capture/wait/cancel values, deadlines, cancellation, and
request/idempotency identity. `--format=json`, the isolated Lua host, and a public versioned same-user
automation socket bind to that model. AI agents use this semantic surface and never parse render
frames or bypass the command dispatcher.

Protocol code owns schemas, encoding, incremental decoding, limits, and versions. It does not open
sockets, dispatch commands, parse terminal bytes, hit-test layouts, or render frames.

### Platform — `src/platform/`

Platform code wraps descriptor ownership, PTY/process creation, resize, Unix sockets, signals,
clocks, polling, terminal modes, and subprocess plumbing. It returns explicit values and errors and
does not mutate core state itself.

### Client — `src/client/`

The client connects, negotiates, decodes physical input into bounded values, forwards typed protocol
messages, writes ANSI frames, observes resize, and restores the outer terminal. Prefix/keymap policy
may remain daemon-owned so built-in and configured bindings converge on the same command dispatcher.
The client must not infer mux state from ANSI output.

### Daemon — `src/daemon/`

The daemon component owns endpoint naming, lock and listener lifecycle, daemonization, endpoint
security, shutdown coordination, and transport bootstrap. It lends accepted connections to the core
reactor; it does not own session or terminal state.

### Extension host — `src/extension/`

One persistent Lua host per daemon loads trusted user configuration. It registers settings, keymaps,
commands, subscriptions, and declarative UI through bounded versioned IPC. C++ validates a complete
candidate generation before atomically committing it. A blocked or crashed host cannot block the
daemon, and the daemon restarts it with bounded backoff.

### Application — `src/app/` and `apps/lemma/`

The application parses CLI arguments, selects control, attached-client, daemon, or extension-host
roles, and wires components together. It owns no mux, terminal, or presentation state.

## Attachment and presentation protocol

### Attach

A successful attachment is an explicit transaction:

1. negotiate daemon/client protocol versions and presentation/input capabilities;
2. resolve the session and allocate bounded daemon-side attachment state;
3. establish canonical dimensions and resize the active layout;
4. invalidate the new attachment's retained presentation cache;
5. generate and queue one complete visible ANSI frame; and
6. enter bounded live input/render operation only after setup succeeds.

No terminal history replay or checkpoint is needed. The daemon can regenerate visible state at any
time from its canonical terminals and topology.

### Live output

PTY output is parsed once by the daemon. Damage accumulates in canonical terminal state. One bounded
urgency scheduler composes keystroke-sized interactive damage and visible mux state changes
immediately while retaining a 2 ms coalescing deadline for sustained autonomous output. A higher
urgency may advance but never postpone the one pending deadline; blocked output and idle or clientless
sessions expose no rendering timer. The daemon composes from latest canonical state, queues the frame
nonblockingly, and continues processing PTYs. Reliable stream order preserves accepted frames.

Only complete bounded frames enter the attachment queue. Composition performs no descriptor I/O.
The core flushes retained bytes nonblockingly after composition and control handoff. Once bytes from a
frame have begun writing, that frame is completed or the connection is retired; it is never spliced
with another frame.

### Lag and redraw recovery

Each client has strict frame, byte, time, and per-turn budgets. The current path retains one frame,
limits a client to 64 KiB/32 attempts per turn, shares 256 KiB across all attached clients through a
persistent round-robin cursor, and disconnects after 5 s without progress or 30 s total frame time.
While a frame is blocked, newer damage remains represented by canonical state rather than accumulating
an output log. After the blocked frame completes, the renderer emits a full redraw from the latest
state. A client that cannot make bounded progress before its deadline is disconnected without
affecting its session.

Reconnect always begins with a fresh full frame. Resume/delta replay is an optional optimization and
is never required for correctness.

### Remote operation

The 1.0 baseline supports operation through an ordinary SSH terminal:

```sh
ssh -t host lemma
```

Remote machine-readable control uses ordinary SSH commands such as
`ssh host lemma list --format=json`. A later `lemma connect HOST` may carry the same framed attach
protocol over SSH stdio, but it keeps the daemon-rendered presentation model and is not a prerequisite
for local daily-driver quality.

## Authoritative execution model

A bounded daemon turn proceeds conceptually in this order:

1. collect descriptor readiness and deadlines;
2. read ready PTYs within per-pane and aggregate budgets;
3. parse output into canonical terminals and collect terminal responses/effects;
4. service queued PTY writes without reordering responses and accepted input;
5. decode a bounded batch of client/control messages;
6. validate and apply typed commands and input against current IDs, topology, and modes;
7. build at most the bounded due presentation work;
8. flush bounded client/control output; and
9. process a bounded batch of deferred extension IPC.

Exact implementation stages may combine work, but a slow client, blocked PTY, output flood, or
extension cannot monopolize a turn. Mode-dependent input cannot overtake preceding PTY output that
changes that mode.

## Input, mouse, and copy model

Clients decode physical input but the daemon owns interpretation against mux state:

- equivalent keyboard and mouse mux actions dispatch the same typed command;
- the daemon hit-tests status, separators, panes, overlays, and selection against its resolved layout;
- application mouse events are translated to pane-local coordinates and encoded through the focused
  canonical terminal's active mouse modes;
- bracketed paste remains a bounded typed value and cannot become prefix commands;
- focus is forwarded only when requested by the focused application; and
- a configurable modifier overrides application mouse capture for Lemma interaction.

Viewport, copy cursor, search, selection, and follow-output state are per attachment but daemon-owned.
Copy mode never pauses PTY parsing. The terminal adapter exposes bounded history and cell traversal to
core copy operations; the renderer presents that view without mutating canonical terminal content.
Clipboard and OSC 52 remain explicit policy boundaries.

## Automation and extension boundary

```text
keyboard/mouse ----typed command-----------------------> core
Lua/agent/JSON ----typed command request---------------> core
Lua/agent/JSON <---result / immutable snapshot / event-- core
Lua extension -----bounded declarative UI--------------> retained model --> renderer
```

Every supported human semantic mutation has an automation equivalent or documented exclusion.
Agents can discover the schema/context, launch commands, mutate topology, send typed input, capture
bounded terminal content, wait for output/exit, inspect results, and cancel work without screen
scraping. Provider-specific agent status and orchestration remain extensions rather than core types.

Extensions and automation clients never receive internal pointers, descriptors, Ghostty values, or
mutable arenas. Event/output subscriptions are bounded; loss is observable and repairable from a
snapshot or bounded canonical capture. The daemon never waits synchronously for Lua or an agent
before PTY, input, or rendering work.

## Data and performance policy

Prefer dense arrays, generational IDs, bitsets, fixed-capacity queues, retained buffers, and value
types over shared ownership. Avoid virtual dispatch in per-byte and per-cell loops. Do not retain raw
PTY output after canonical parsing merely for possible clients; explicit observation buffers are
bounded, sequenced, report gaps, and are never required for terminal correctness.

Required end-to-end measurements include key-to-PTY, key-to-visible, attach-to-visible, sparse editor,
full redraw, high scroll, resize storms, copy/search/mouse interaction, blocked clients, agent command/
capture/wait latency, idle CPU, wakeups, bytes, and memory at representative pane counts. Comparable
workloads use pinned tmux, Zellij, Herdr, and Lemma versions before any relative performance claim.
Remote measurements are labeled by SSH, terminal, latency, and bandwidth conditions.

## Build boundaries

The internal targets remain:

- `lemma_base`: assertions and dependency-free foundations;
- `lemma_terminal`: the sole authoritative Ghostty adapter;
- `lemma_platform`: operating-system mechanisms;
- `lemma_protocol`: private attach plus public semantic automation and extension framing;
- `lemma_render`: daemon-owned ANSI composition and future presentation values;
- `lemma_core`: authoritative stores, commands, attachment/view state, and reactor policy;
- `lemma_extension`: Lua configuration and isolated host process;
- `lemma_daemon`: per-user endpoint lifecycle;
- `lemma_client`: thin transport/input/output and outer-terminal lifecycle;
- `lemma_app`: CLI parsing and process-role composition; and
- `lemma`: the bootstrap in `apps/lemma/main.cpp`.

Targets remain cohesive rather than becoming one target per class.

## Source placement rules

- A directory represents a subsystem or ownership boundary, not a class.
- Keep private headers beside implementations under `src/`.
- Put headers under `include/lemma/` only for deliberate cross-component or public APIs.
- Do not add empty speculative source files.
- Keep structural moves separate from behavior changes where tests can distinguish them.
- Update [`single-pane-runtime.md`](single-pane-runtime.md) and
  [`current-capabilities.md`](current-capabilities.md) only when implemented ownership changes.

## Architectural review questions

Before accepting a change, ask:

1. Who owns every new mutable value?
2. What bounds every queue, frame, decoder, payload, loop, and allocation?
3. Can this client, PTY, or extension delay unrelated PTY progress?
4. Can visible state be rebuilt from daemon authority without an unbounded log?
5. Does a stable generational ID identify every explicit target?
6. Does any Ghostty type or private layout escape its adapter?
7. Do keyboard, mouse, CLI, Lua, scripts, and AI agents converge on one typed command?
8. Can outer-terminal state be restored after every exit and partial-startup path?
9. How are malformed input, capacity exhaustion, backpressure, and recovery tested?
10. Which end-to-end latency, bytes, memory, or soak evidence validates the change?
