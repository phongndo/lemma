# Current capabilities

## Audit basis

Audited at repository HEAD `60acc8a` from current source, public headers, CMake targets, tests, and checked-in benchmark tooling. Only implemented facts are included.

Status terms:

- **Working** — implemented end to end with direct test coverage.
- **Partial** — useful implementation exists, but the supported path or behavior is incomplete.
- **Absent** — no supported user-facing implementation exists.

## Current architecture

Lemma is one C++23 executable with client, daemon, extension-host, and control roles. A per-user daemon runs one `poll`-based reactor and currently owns both semantic mux state and runtime resources in `src/core/engine.cpp`.

The current in-memory hierarchy is `Session -> Tab -> Pane`, but semantic and runtime state are not yet separated into Core/Runtime stores:

- `Pane` contains `PaneId`, committed layout geometry, and one inline `PaneRuntime`. `PaneRuntime` owns the child PID, PTY descriptor, `vt::Terminal`, PTY write queue, presentation gate, process-title refresh state, compression scheduling, trace state, and their teardown.
- `Tab` currently contains generational pane slots, a binary layout tree, geometry, focus, previous focus, zoom, and suspension state.
- `Session` currently contains generational tab slots, launch context, active/previous tab, one client descriptor and decoder, frame storage/output progress, copy/search state, command trace, and frame scheduler.
- An Attachment/AttachmentRuntime split does not yet exist as a first-class model.

The target ownership model is in [`architecture.md`](architecture.md).

## CLI, daemon, and lifecycle

| Capability | Status | Current behavior |
| --- | --- | --- |
| Default invocation | Working | Plain `lemma` creates or enters session `default`; an already attached session fails visibly. |
| Named sessions | Working | `new`, `start`, `attach`, `list`, `tabs`, `kill`, and `kill-all` are implemented. |
| Explicit shutdown | Working | `shutdown` warns; `shutdown --confirm` stops the daemon and owned sessions. |
| Help/version/errors | Working | Dedicated output and nonzero invalid-command behavior exist. |
| Per-user daemon | Working | Owner-only Unix socket, lock, stale-socket checks, daemonization, and cleanup. |
| Detach continuity | Working | Client detach/EOF does not end pane processes while the daemon remains alive. |
| Restart/reboot durability | Absent | Process, topology, terminal, and scrollback state are not persisted across daemon death. |
| Multiple viewers/controllers | Absent | One attached client is allowed per session. |
| Machine-readable semantic API | Absent | There is no public JSON command surface or persistent agent automation socket. |
| Installable release artifacts | Working | The Nix flake exposes the default release package as `lemma` and a separate debug package as `delemma`. |

Session names are 1–32 ASCII letters, digits, underscores, or hyphens. The daemon admits up to 64 sessions.

## Tabs, panes, and layout

| Capability | Status | Current behavior |
| --- | --- | --- |
| Tabs | Working | Up to 16 tabs per session; create, cycle, numeric select, list, and close. |
| Split panes | Working | Nested left/right and top/bottom binary splits, up to 64 panes per session and 4,096 daemon-wide. |
| Focus/close/zoom | Working | Directional/next/previous focus, close, and zoom use generational pane IDs. |
| Resize | Working | Outer resize resolves active layout and coordinates Ghostty/PTY resize with rollback/fail-closed behavior. |
| Inactive output | Working | Inactive tabs continue draining and parsing PTY output. |
| Status | Working | A top row shows session, contiguous tab positions, and bounded process-derived titles. |
| Stored ratios and interactive resize | Absent | Splits use equal halves; keyboard/mouse ratio changes are not implemented. |
| Rename/reorder/link | Absent | User session/tab rename, stable reorder, and cross-session linking are not implemented. |
| Pane identification UI | Absent | IDs appear in listings, but there is no pane overlay or naming UX. |

Session, tab, pane, and attached-client references use hierarchical generational IDs internally. The one-shot control protocol remains mostly name-oriented.

## Input, copy, and mouse

| Capability | Status | Current behavior |
| --- | --- | --- |
| Prefix keymap | Working | `C-b` dispatches built-in pane/tab/copy commands; `C-b C-b` sends a literal prefix. |
| Basic key encoding | Partial | Enter, Tab, Backspace, Ctrl-A–Z, arrows, Home, and End use Ghostty encoding; other legacy bytes pass through. |
| Typed rich keyboard input | Absent | The attached protocol does not carry complete semantic key/repeat/release/text metadata. |
| Typed paste/focus | Partial | The terminal adapter exposes Ghostty paste support, but attached input remains a legacy byte message. |
| Copy mode | Working for keyboard path | Vi/arrow navigation, tracked selection, visible cursor/range, bounded literal search, viewport hold, and OSC 52 user copy are integrated. |
| Native clipboard | Absent | Copy output relies on bounded user-initiated OSC 52. |
| Mouse mux operation | Absent | No typed mouse decode, layout hit testing, focus, drag resize, status interaction, or mouse selection. |
| Application mouse forwarding | Absent | Outer coordinates are not translated and encoded as pane-local semantic mouse events. |

Copy/search work is daemon-owned for the one attachment. PTY parsing continues while the viewport is held. Search inspects at most a bounded slice and does not retain a duplicate grid or match list.

## Terminal and presentation

| Capability | Status | Current behavior |
| --- | --- | --- |
| Canonical terminal | Working | Every pane has one `vt::Terminal` backed by pinned `libghostty-vt`. |
| Adapter isolation | Working | Ghostty headers and handles remain private to `lemma_terminal`; public consumers use Lemma types. |
| PTY parse/effects/responses | Working | Output is parsed once; bounded terminal responses are ordered before later accepted input; overflow fails pane integrity. |
| Scrollback and reflow | Working | Ghostty owns canonical history; byte and optional line bounds are configured independently. |
| Selection/search/formatting | Working | Adapter wraps tracked selection, viewport, bounded search, formatting, and incremental compression primitives. |
| Damage rendering | Working | Dirty rows/cell spans, scroll detection, effective RGB projection, cursor, and mode projection emit bounded ANSI. |
| Pane composition | Working | Status, separators, panes, copy highlight/cursor, synchronized output, and focused terminal modes compose server-side. |
| Full reconstruction | Working | Attach, resize, active-tab changes, and lag recovery can force a complete daemon-rendered frame. |
| Slow-client isolation | Working | One retained transaction, bounded write budgets, fair cursor, progress/total deadlines, and full-redraw recovery. |
| Portable terminal replicas/checkpoints | Intentionally absent | The rejected design and evidence are summarized in [`terminal.md`](terminal.md). |
| Graphics | Disabled | Kitty storage/media/APC are disabled at the adapter boundary. |
| Terminal identity/terminfo | Partial | Panes advertise xterm-compatible environment values; Lemma ships no dedicated terminfo entry. |

The current private attached-client protocol is version 1.0 and transports daemon-rendered ANSI.

## Configuration and extensions

| Capability | Status | Current behavior |
| --- | --- | --- |
| Isolated Lua 5.5 host | Working | An explicit config starts one managed child process with a 16 MiB Lua allocation quota. |
| No-config path | Working | No extension runtime or Lua process is created when configuration is absent. |
| Transactional registration | Working | Bounded command, keymap, event-subscription, and sidebar declarations commit as a generation. |
| Crash/block isolation | Working foundation | IPC is nonblocking and processed after critical reactor work; disconnect clears the generation and schedules restart. |
| Settings applied to mux | Absent | `lemma.setup` does not currently alter product settings. |
| Lua command callbacks/keymaps | Absent from user path | Registrations are retained but do not drive attached commands. |
| Snapshots/events/UI/process APIs/reload | Absent | No complete runtime integration exists. |

## Testing and measurement present today

The build defines component tests, isolated real-process PTY tests, a standalone steady-state allocation audit, terminal/render/core/protocol benchmarks, memory census tooling, and Lemma/tmux/Zellij comparison drivers. CI covers formatting, build/tests, clang-tidy, clangd, Linux ASan/UBSan, workflow/script checks, and scheduled host matrices.

Measured evidence and caveats are in [`performance.md`](performance.md) and [`memory.md`](memory.md). Test existence does not imply every product capability in [`product-contract.md`](product-contract.md) is implemented.
