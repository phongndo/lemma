# Architecture

Lemma is one C++23 executable with client, daemon, and control roles. One per-user daemon owns all
live mux and terminal state. Clients are replaceable input and presentation edges.

```text
Lua config ─> isolated host ─> validated draft ─> immutable native generation
                                                  │
physical input ─> input policy ─┐                  │
CLI / API / mouse ───────────────┴─> typed command ─> Core ─> Runtime
                                                            ├─> PTY/process
PTY output ─> Ghostty terminal ─> render/composition ───────┴─> client
```

## Model

The kernel hierarchy is:

```text
Session -> Tab -> Pane
```

- A **Session** owns launch context, ordered Tabs, identity, lifecycle, and attachment policy.
- A **Tab** owns a pane layout, focus, zoom, ordering, and title policy.
- A **Pane** is the semantic identity of one process surface.
- An **Attachment** is the current controller's view and interaction state for a Session.

Projects, worktrees, tasks, and agent runs are not kernel objects. They can compose stable IDs
through the public API.

Semantic identity is separate from external-resource lifetime:

```text
Session != Attachment != AttachmentRuntime
Pane    != PaneRuntime
```

`PaneRuntime` owns the child process, PTY, terminal, write queue, and scheduling state for a Pane.
`AttachmentRuntime` owns the replaceable client connection, decoder, retained output progress,
presentation caches, and deadlines. Losing an AttachmentRuntime detaches the client; it does not
destroy the Session.

## Components

| Component | Responsibility |
| --- | --- |
| `lemma_app` | CLI grammar and executable role selection |
| `lemma_daemon` | Endpoint ownership, connection admission, and the reactor |
| `lemma_api` | Public Action, Procedure, Event, JSON, and schema values |
| `lemma_core` | Session/Tab/Pane semantics, commands, layout, and copy policy |
| `lemma_input` | Compiled physical keymaps and per-Attachment input contexts |
| `lemma_config` | Bounded configuration values, wire validation, and native generation compilation |
| `lemma_extension` | Isolated Lua host lifecycle and transactional configuration admission |
| `lemma_runtime` | Processes, PTYs, scheduling, input execution, resizing, and frame progress |
| `lemma_terminal` | The only boundary allowed to include or link against libghostty-vt |
| `lemma_render` | Non-authoritative pane and frame presentation |
| `lemma_protocol` | Bounded private attachment codec |
| `lemma_client` | Host input, outer-terminal presentation, and restoration |
| `lemma_platform` | OS I/O, PTYs, and terminal mode mechanisms |

Core links no Lua VM, PTY, socket, process, or terminal-emulator owner. Runtime executes accepted
semantic intent using those mechanisms. The daemon borrows one immutable compiled configuration
generation; input routing and runtime operation never call into the host process.

## Authority and ownership

Every mutable fact has one authoritative owner:

| State | Owner |
| --- | --- |
| Sessions, Tabs, Panes, layout, focus, zoom, stable IDs | Core |
| Attachment view plus copy and rename semantic state | Core |
| All key bindings, context options, transitions, and transient routing state | Input policy |
| Lua VM and uncommitted configuration draft | Extension host process |
| Processes, PTYs, descriptors, polling, clocks | Runtime |
| Canonical screen, history, modes, cursor, selection primitives | Ghostty behind `vt::Terminal` |
| Connection decoding, output progress, deadlines | AttachmentRuntime |
| Frame buffers and physical presentation shadow | Render/runtime presentation |

A projection may be cached for presentation, but it remains bounded, invalidatable, and
authoritatively reconstructible. Stable IDs cross component and trust boundaries; borrowed
references remain owner-local.

The shipped interaction policy is configuration data, not a privileged routing path. The default
preset and an equivalent explicit user policy compile into the same immutable representation. Core
implements semantic operations such as resizing or moving a copy selection; configuration alone
selects the keys and routing-context transitions that invoke them.

## Commands

Keyboard, mouse, CLI, and Procedures converge on the same typed command path:

```text
input -> validate actor, target, bounds, and policy
      -> one semantic transition
      -> typed result and runtime intent
```

CLI syntax, JSON, and Procedure references are frontend representations rather than Core state. A
Procedure resolves each reference to concrete IDs before submitting the ordinary Action. Lifecycle
commands run through the deterministic `SessionMachine`: Core stages fallible semantic owners,
Runtime executes a bounded typed spawn/resize/retire effect batch, and Core publishes the transition
only after required effects succeed. Events observe committed state and never provide another
mutation path. The deterministic mux harness records concrete targets, arguments, and Runtime
outcomes at this boundary. Versioned traces therefore replay without the generator, and recorded
result/state checkpoints turn minimized failures into permanent regression corpus entries.

Application input is distinct from mux commands. The daemon input policy resolves physical
bindings; Runtime then asks the target Pane's Ghostty terminal to encode mode-dependent keyboard,
paste, focus, and mouse input.

## Terminal and presentation flow

Ghostty owns VT semantics. Lemma owns process, mux, security, scheduling, and presentation policy.
PTY bytes are parsed once into the Pane's canonical terminal:

```text
PTY -> Ghostty parse
          ├─> terminal responses -> ordered PTY write queue
          ├─> effects -> Lemma policy
          └─> damage -> render -> pane composition -> attached client
```

Terminal responses enter the Pane's ordered write queue before later accepted application input.
Attach, resize, tab changes, and lag recovery can rebuild a complete ANSI frame from daemon-owned
state. The client does not own a second terminal grid or PTY replay log.

Resize is coordinated in one direction:

```text
Attachment geometry -> Core layout -> Pane geometry -> PTY size -> Ghostty size
```

The child PTY receives the target dimensions before Ghostty parses output at those dimensions.
Multi-pane resize publishes semantic geometry only after the dependent runtime work succeeds.

## Invariants

1. The daemon is the sole authority for mux state and Pane terminal truth.
2. `Session -> Tab -> Pane` is the only kernel hierarchy.
3. Semantic objects and runtime resources have distinct identities and lifetimes.
4. Every mutable fact has one owner; other representations are derived.
5. Every semantic mutation uses a typed command and typed result.
6. Ghostty representations remain private to `lemma_terminal`.
7. Required PTY-response, application-input, and presentation ordering is explicit.
8. Queues, payloads, loops, timeouts, and retained presentation work are bounded.
9. Slow or malformed clients and observers cannot prevent unrelated PTY progress.
10. Visible state is reconstructible without retaining an unbounded event, frame, or PTY-byte log.
11. Session lifecycle transitions preserve the complete semantic and Core/Runtime ownership
    invariants after every atomic operation; rejected effects do not publish partial Core state.
