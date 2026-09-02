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
| `lemma_api` | Public Proc, nested Command, Event, JSON, and schema values |
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
| Attachment view plus copy, rename, command-line editor, bounded command history, and message log | Core |
| All key bindings, context options, transitions, and transient routing state | Input policy |
| Lua VM and uncommitted configuration draft | Extension host process |
| Processes, PTYs, descriptors, polling, clocks | Runtime |
| Canonical screen, history, modes, cursor, selection primitives | Ghostty behind `vt::Terminal` |
| Attachment connection decoding, output progress, and transient message/frame deadlines | AttachmentRuntime |
| Admitted Proc execution, waits, and owner-generation cancellation | Reactor Proc table |
| Frame buffers and physical presentation shadow | Render/runtime presentation |

A projection may be cached for presentation, but it remains bounded, invalidatable, and
authoritatively reconstructible. Stable IDs cross component and trust boundaries; borrowed
references remain owner-local.

The shipped interaction policy is configuration data, not a privileged routing path. The default
preset and an equivalent explicit user policy compile into the same immutable representation. Core
implements semantic commands such as resizing or moving a copy selection; configuration alone
selects the keys and routing-context transitions that invoke them.

## Commands

Keyboard and mouse interaction use direct typed input commands. Agent execution enters through a
Proc containing one to 64 ordered Commands:

```text
CLI / CONTROL -> Proc admission -> compiled Command -> Command executor -> Core command / Runtime intent
                     │                    │                   │
                     │                    │                   └─> lemma.command-result/v1
                     │                    └─> at most one per reactor turn
                     └─> validate all Commands and backward references once
```

`lemma.proc/v1` is the sole public execution request. CLI syntax and backward result references are
frontend representations rather than Core state. Before admission, Proc validation checks every
Command and reference. Execution resolves references to concrete generational IDs and performs
authoritative lifetime and ownership checks immediately before each Command. Closing an owning
connection invalidates its generation and cancels the Proc before another Command.

Lifecycle commands run through the deterministic `SessionMachine`: Core stages fallible semantic
owners, Runtime executes a bounded typed spawn/resize/retire effect batch, and Core publishes the
transition only after required effects succeed. Events observe committed state and never provide
another mutation path. The deterministic mux harness records concrete targets, arguments, and
Runtime outcomes at this boundary. Versioned traces therefore replay without the generator, and
recorded result/state checkpoints turn minimized failures into permanent regression corpus entries.

The interactive command line is another typed frontend, not another command executor. One native
catalog owns command paths and completion metadata. The attachment-owned editor parses its bounded
human grammar, fills omitted targets with current stable IDs, and dispatches the resulting typed
commands through the same executor used by Proc. While editing, the status row contains only the
command prompt. A failed submission closes the prompt and projects its typed result as a left-aligned
status message rather than exposing JSON. One monotonic AttachmentRuntime deadline expires that
projection after 1.5 seconds, while input can dismiss it immediately; the bounded Attachment message
log remains available through a synthetic read-only full-pane projection. The status renderer is
the sole owner of interaction chrome: active routing contexts and search prompts replace normal
Session/Tab status, while pane composition contains no mode-overlay path. Command history remains a
separate bounded fact. An optional configured file seeds the daemon-wide initial history and is
atomically replaced on clean shutdown only after a successful load or confirmed absence; live
Attachment histories still diverge independently. A
Session switch transfers one
drained connection decoder and sequence to an existing detached Session, then forces a full redraw;
it never creates a nested client or restarts the terminal process. The catalog is the sole
projection boundary for command descriptors, and handlers at that boundary compile to bounded typed
Lemma commands rather than introducing another execution path.

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
