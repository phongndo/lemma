# Architecture

Lemma is one C++23 executable with client, daemon, and control roles. One per-user daemon owns
all live mux and terminal state. Clients are replaceable input and presentation edges.

```text
Lua config -> isolated host -> validated draft -> immutable native generation
                                                       |
physical input -> compiled input policy ----------------+
CLI / API / mouse -> typed command -> Core -> Runtime -> PTY/process
extension -> Proc / SurfaceUpdate -------------|
PTY output -> Ghostty terminal -> retained Scene -> client
```

This document owns component boundaries and data flow. User behavior is in [Usage](usage.md),
execution semantics in [Automation API](api.md), and external UI contracts in
[Extensions](extensions.md).

## Model and lifetimes

The kernel hierarchy is `Session -> Tab -> Pane`:

- A **Session** owns launch context, ordered Tabs, identity, lifecycle, and attachment policy.
- A **Tab** owns pane layout, focus, zoom, ordering, and title policy.
- A **Pane** is the semantic identity of one process surface.
- An **Attachment** is the controller's view and interaction state for a Session.

Projects, worktrees, tasks, and agent runs compose stable IDs through the public API rather than
becoming kernel objects.

Semantic identities have different lifetimes from external resources:

```text
Session != Attachment != AttachmentRuntime
Pane    != PaneRuntime
```

`PaneRuntime` owns the child process, PTY, terminal, write queue, and scheduling state.
`AttachmentRuntime` owns the replaceable client connection, decoder, retained output progress,
presentation caches, and deadlines. Losing it detaches the client; it does not destroy the Session
or semantic Attachment. Stable IDs cross boundaries; borrowed references remain owner-local.

## Components

[Build targets](../CMakeLists.txt) define the dependency boundaries:

| Component | Responsibility |
| --- | --- |
| `lemma_app` | CLI grammar and executable role selection |
| `lemma_daemon` | Endpoint ownership, connection admission, and reactor |
| `lemma_api` | Public Proc, Command, Event, JSON, and schema values |
| `lemma_core` | Session/Tab/Pane semantics, commands, layout, and copy policy |
| `lemma_input` | Compiled physical keymaps and per-Attachment routing contexts |
| `lemma_config` | Configuration values, validation, and native generation compilation |
| `lemma_extension_contract` | Lua command declarations and language-neutral extension protocol |
| `lemma_extension` | Isolated command host, Lua callbacks, external children, and configuration admission |
| `lemma_runtime` | Extension generations/Surfaces, processes, PTYs, scheduling, input, resize, and frame progress |
| `lemma_terminal` | The only boundary allowed to include or link against libghostty-vt |
| `lemma_render` | Non-authoritative pane and frame presentation |
| `lemma_protocol` | Bounded private attachment codec |
| `lemma_client` | Host input, outer-terminal presentation, and restoration |
| `lemma_platform` | OS I/O, PTYs, and terminal mode mechanisms |

Core links no Lua VM, PTY, socket, process, or terminal-emulator owner. Runtime executes accepted
semantic intent using those mechanisms. Ghostty representations remain private to `lemma_terminal`;
Lemma-facing types and borrowed views make lifetimes explicit.

## Authority

| Mutable state | Authoritative owner |
| --- | --- |
| Sessions, Tabs, Panes, layout, focus, zoom, stable IDs | Core |
| Attachment view, copy/editor state, command history, and message log | Core |
| Key bindings, context options, transitions, and transient routing state | Input policy |
| Lua VM, coroutine state, and uncommitted configuration draft | Isolated host process |
| Processes, PTYs, descriptors, polling, clocks | Runtime |
| Canonical screen, history, modes, cursor, selection primitives | Ghostty behind `vt::Terminal` |
| Connection decoding, output progress, and transient frame/message deadlines | AttachmentRuntime |
| Admitted Proc execution, waits, and owner-generation cancellation | Reactor Proc table |
| Hosted command invocation, captured targets, deadline, and attachment-generation owner | Reactor-owned command runtime |
| Extension capabilities, generations, Surface IDs, retained Grids, and Surface focus | ExtensionRuntime |
| Frame buffers, Scene composition, damage, and physical presentation shadow | Scene/render runtime |

Presentation caches are bounded, invalidatable projections, reconstructible from their owners.
Extension aggregate resource accounting is likewise derived from peer-owned transport and reservation
state, not a competing mutable ledger. Slow peers cannot prevent unrelated PTY progress; queues and
per-turn work have explicit bounds.

## Mutation and configuration

Every semantic mutation uses a typed command and result. CLI syntax and backward result references
are frontend representations, not Core state. Proc admission validates the complete request once;
execution resolves concrete generational IDs and checks lifetime and ownership immediately before
each Command. Closing an owner revokes its remaining work.

Lifecycle transitions go through [`SessionMachine`](../src/core/session_machine.cpp). Core stages
fallible semantic owners, Runtime executes a bounded spawn/resize/retire effect batch, and Core
publishes only after required effects succeed. Rejected effects do not publish partial Core state.
Events observe committed state and never provide a second mutation path.

The interactive command line is another typed frontend using the same executor. One native catalog
owns command paths and completion metadata. A Session switch transfers a drained connection decoder
and sequence, then forces a full redraw; it does not create a nested client. The status renderer owns
interaction chrome; pane composition does not overlay command or copy-search prompts.

The daemon borrows one immutable compiled configuration generation. Shipped and user-declared input
policies compile through the same path: Core owns semantic commands; configuration chooses their keys
and routing transitions. Ordinary input, PTY processing, and composition never call into Lua.

Keybindings compile hosted names to bounded command indices. Routing captures invocation context and
queues at most one invocation per Attachment; host service, not the input stack, launches it. The
isolated host runs either a Lua coroutine or an argv-declared external child with bounded diagnostics.
External children present UI through the ordinary extension endpoint and remain invocation-scoped.
Connection generations are owned by the daemon's Session store, surviving Session slot reuse.

Explicit hosted commands communicate asynchronously with the isolated host. Lua callbacks yield Procs
through `ctx:proc`; those use ordinary validation, admission, and round-robin execution. Their typed
completion owner is the originating attachment generation, revoked on detach or Session switch.
Cancellation keeps the invocation slot and deadline until acknowledgement so a blocked callback cannot
escape its watchdog. Host failure removes hosted commands without changing compiled input policy or
pane lifetime. See [Configuration](configuration.md#failure-and-lifetime) for the public behavior.

## Terminal and presentation flow

Ghostty owns VT semantics. Lemma owns process, mux, security, scheduling, and presentation policy.
PTY bytes are parsed once into the Pane's canonical terminal:

```text
PTY -> Ghostty parse
          |-> terminal responses -> ordered PTY write queue
          |-> effects -> Lemma policy
          +-> damage -> retained Scene composition -> attached client
```

Terminal responses enter the ordered write queue before later accepted application input.
Mode-dependent keyboard, paste, focus, and mouse encoding comes from the target Pane's Ghostty
terminal. Attach, resize, tab changes, and lag recovery can reconstruct a full ANSI frame from
daemon-owned state; the client owns neither a second terminal grid nor a PTY replay log.

Scene composes Pane projections and extension-owned retained Grids. Native code owns clipping,
occlusion repair, damage, and cursor arbitration. Extension code never enters composition.

```text
Attachment geometry -> Surface placement -> Core layout -> Pane geometry -> PTY size -> Ghostty size
```

Docks change the effective pane viewport; floats and overlays do not. The child PTY receives target
dimensions before Ghostty parses output at those dimensions. Multi-pane resize publishes semantic
geometry only after dependent runtime work succeeds.
