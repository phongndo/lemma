# Current capabilities

## Audit basis

Audited from the current source, public headers, CMake targets, tests, and checked-in benchmark tooling. Only implemented facts are included.

Status terms:

- **Working** — implemented end to end with direct test coverage.
- **Partial** — useful implementation exists, but the supported path or behavior is incomplete.
- **Absent** — no supported user-facing implementation exists.

## Current architecture

Lemma is one C++23 executable with client, daemon, extension-host, and control roles. A per-user daemon runs one `poll`-based reactor and currently owns both semantic mux state and runtime resources in `src/core/engine.cpp`.

The current in-memory hierarchy is `Session -> Tab -> Pane`. Pane semantic and runtime ownership are separate, while attachment state remains transitional:

- `Pane` contains only `PaneId` and committed layout geometry. A separate bounded runtime store resolves the full generational `SessionId -> TabId -> PaneId` address to one `PaneRuntime`.
- `PaneRuntime` owns the child PID, PTY descriptor, `vt::Terminal`, PTY write queue, presentation gate, process-title refresh state, compression scheduling, trace state, typed failure state, and teardown. Staged creation publishes the semantic pane and runtime counterpart together; runtime failure becomes a typed outcome consumed by Core pane-exit policy.
- `Tab` currently contains generational pane slots, a binary layout tree, geometry, focus, previous focus, zoom, and suspension state. Layout resize is planned across the tab, applied transactionally to PaneRuntimes, and committed to semantic pane geometry only after Runtime succeeds.
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
| Key encoding | Working | The client requests Kitty disambiguation, event, alternate-key, and associated-text metadata without requesting `report all keys`; layout and IME text therefore remains ordinary text on hosts that omit associated text. Typed metadata is preserved and Ghostty encodes it against each pane's active modes. |
| Typed paste/focus | Working | Outer bracketed-paste and focus reporting are enabled while attached. Reports are decoded across arbitrary read fragmentation, transported as bounded typed messages, and encoded from canonical Ghostty modes. Paste remains one opaque event up to 1 MiB and bypasses mux-prefix interpretation. |
| Copy mode | Working for keyboard path | Vi/arrow navigation, tracked selection, visible cursor/range, bounded literal search, viewport hold, and OSC 52 user copy are integrated. |
| Native clipboard | Absent | Copy output relies on bounded user-initiated OSC 52. |
| Mouse mux operation | Partial | SGR mouse input is validated against read-time geometry, hit-tested across pane rectangles, focuses a pressed pane, and retains pane ownership through drag/release. Drag resize, status interaction, and mux mouse selection remain absent. |
| Application mouse forwarding | Working | Outer button/drag SGR capture is enabled while attached. Valid events are translated to bounded pane-local coordinates and encoded by Ghostty from the target pane's canonical mouse modes. |

Copy/search work is daemon-owned for the one attachment. PTY parsing continues while the viewport is held. Search inspects at most a bounded slice and does not retain a duplicate grid or match list.

## Terminal and presentation

| Capability | Status | Current behavior |
| --- | --- | --- |
| Canonical terminal | Working | Every pane has one `vt::Terminal` backed by pinned `libghostty-vt`. |
| Adapter isolation | Working | Ghostty headers and handles remain private to `lemma_terminal`; public consumers use Lemma types. |
| PTY parse/effects/responses | Working | Output is parsed once; bounded terminal responses are ordered before later accepted input; response overflow or Ghostty VT-processing failure is sticky and fails closed. Bell, title, PWD, progress, notification, clipboard, enquiry, and bounded unknown-sequence effects are explicitly drained and policy-routed; application clipboard writes are denied and unknown sequences dropped by default. |
| Scrollback and reflow | Working | Ghostty owns canonical history; byte and optional line bounds are configured independently. |
| Selection/search/formatting | Working | Adapter wraps tracked selection, viewport, bounded search, formatting, and incremental compression primitives. |
| Damage rendering | Working | Dirty rows/cell spans, grapheme-safe scroll detection, semantic default/indexed colors, distinguishable isolated RGB overrides, cursor, and mode projection emit bounded ANSI. Exact equal-to-default override provenance and transactional OSC 8 hyperlink projection still require narrower Ghostty render APIs. |
| Pane composition | Working | Status, separators, panes, copy highlight/cursor, synchronized output, and focused terminal modes compose server-side. |
| Full reconstruction | Working | Attach, resize, active-tab changes, and lag recovery can force a complete daemon-rendered frame. |
| Slow-client isolation | Working | One retained transaction, bounded write budgets, fair cursor, progress/total deadlines, and full-redraw recovery. |
| Portable terminal replicas/checkpoints | Intentionally absent | The rejected design and evidence are summarized in [`terminal.md`](terminal.md). |
| Graphics and glyph protocol | Disabled | Kitty storage/media/APC and Glyph Protocol advertisement are disabled until bounded canonical presentation support exists. |
| Terminal identity/terminfo | Partial | Child queries receive a consistent Lemma identity, xterm-compatible DA, geometry, color scheme, and `xterm-256color` terminfo name; Lemma still ships no dedicated terminfo entry. |

The current private attached-client protocol is version 2.1. It transports daemon-rendered ANSI, bounded typed key/paste/focus/mouse input, and a bounded client observation of the host default colors and 16-color ANSI palette during attach.

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

The build defines component tests, isolated real-process PTY tests, a standalone steady-state allocation audit, terminal/render/core/protocol benchmarks, memory census tooling, and Lemma/tmux/Zellij/Herdr comparison drivers. The process harness also measures 1/4/16 logical workspaces and named sessions so one-daemon and one-server-per-unit models are not conflated. CI covers formatting, build/tests, clang-tidy, clangd, Linux ASan/UBSan, workflow/script checks, and scheduled host matrices.

Measured evidence and caveats are in [`performance.md`](performance.md) and [`memory.md`](memory.md). Test existence does not imply every product capability in [`product-contract.md`](product-contract.md) is implemented.
