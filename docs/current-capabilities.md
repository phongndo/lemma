# Current capabilities

## Audit basis

Audited from the current source, public headers, CMake targets, tests, and checked-in benchmark tooling. Only implemented facts are included.

Status terms:

- **Working** — implemented end to end with direct test coverage.
- **Partial** — useful implementation exists, but the supported path or behavior is incomplete.
- **Absent** — no supported user-facing implementation exists.

## Current architecture

Lemma is one C++23 executable with client, daemon, extension-host, and control roles. A per-user daemon runs one `poll`-based reactor. The `lemma_core` target owns only semantic commands and the Session/Tab/Pane/Attachment model; `lemma_runtime` owns reactor and external-resource mechanics.

The current in-memory hierarchy is `Session -> Tab -> Pane`, with separate semantic and runtime counterparts:

- `Pane` contains only `PaneId` and committed layout geometry. A separate bounded runtime store resolves the full generational `SessionId -> TabId -> PaneId` address to one `PaneRuntime`.
- `PaneRuntime` owns the child PID, PTY descriptor, `vt::Terminal`, PTY write queue, presentation gate, process-title refresh state, compression scheduling, trace state, typed failure state, and teardown. Staged creation publishes the semantic pane and runtime counterpart together; runtime failure becomes a typed outcome consumed by Core pane-exit policy.
- `Tab` currently contains generational pane slots, a binary layout tree, geometry, focus, previous focus, zoom, and suspension state. Layout resize is planned across the tab, applied transactionally to PaneRuntimes, and committed to semantic pane geometry only after Runtime succeeds.
- `Session` contains only identity, bounded launch context, generational tab slots, active/previous tab, lifecycle, and theme-binding policy. Its destructor performs no I/O.
- `Attachment` owns the stable semantic relationship to one Session, viewport geometry, copy policy, and a fully scoped generational pane or split-divider mouse capture target. Current single-controller policy creates one Attachment per Session.
- `AttachmentRuntime` owns the replaceable connection descriptor, decoder, retained frame and output progress, protocol generations, copy/search continuation, clipboard staging, deadlines, backpressure, presentation caches, trace state, and teardown.
- Runtime stores one direct aggregate record per Session. Session, Attachment, and AttachmentRuntime retain stable addresses with no extra connection lookup, allocation, virtual dispatch, or shared ownership on hot paths.

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
| Resize | Working | Outer-window resize samples coalesce to one settled endpoint after a 50-ms quiet interval, or immediately before subsequent user input. The daemon then resolves the active layout and coordinates Ghostty/PTY resize with rollback/fail-closed behavior. |
| Inactive output | Working | Inactive tabs continue draining and parsing PTY output. |
| Status | Working | A top row shows session, contiguous tab positions, and bounded process-derived titles. Copy mode preserves those titles and projects its position or search feedback as a bounded top-right pane overlay. |
| Stored ratios and interactive resize | Working | Every branch owns a bounded fixed-point ratio. `C-b C-Arrow` or `C-b H/J/K/L` moves the nearest matching structural divider by one cell. Dragging a projected separator resizes and reflows the real pane surfaces live; release converges child PTYs exactly at the final clamped pointer position. Ratios survive outer resize, zoom, tab changes, detach, and reattach. |
| Rename/reorder/link | Absent | User session/tab rename, stable reorder, and cross-session linking are not implemented. |
| Pane identification UI | Absent | IDs appear in listings, but there is no pane overlay or naming UX. |

Session, tab, pane, semantic Attachment, and runtime connection references use distinct generational IDs internally. The one-shot control protocol remains mostly name-oriented.

## Input, copy, and mouse

| Capability | Status | Current behavior |
| --- | --- | --- |
| Prefix keymap | Working | `C-b` dispatches built-in pane/tab/copy commands; `C-b C-b` sends a literal prefix. `C-b C-Arrow` and `C-b H/J/K/L` resize splits by one cell; `C-b /` and `C-b ?` enter copy mode directly at forward or backward search. |
| Key encoding | Working | The client requests Kitty disambiguation, event, alternate-key, and associated-text metadata without requesting `report all keys`; layout and IME text therefore remains ordinary text on hosts that omit associated text. Typed metadata is preserved and Ghostty encodes it against each pane's active modes. |
| Typed paste/focus | Working | Outer bracketed-paste and focus reporting are enabled while attached. Reports are decoded across arbitrary read fragmentation, transported as bounded typed messages, and encoded from canonical Ghostty modes. Paste remains one opaque event up to 1 MiB and bypasses mux-prefix interpretation. |
| Copy mode | Working | Typed Vim-shaped navigation (`h/j/k/l`, words, line/history/viewport, half/full-page, arrows), character/line/block Visual selection, endpoint swapping, tracked pane-local mouse selection, incremental wrapping literal search from the copy cursor with central-context match placement, viewport hold, a pane-local position overlay, and OSC 52 user copy are integrated. |
| Native clipboard | Absent | Copy output relies on bounded user-initiated OSC 52. |
| Mouse mux operation | Partial | SGR mouse input is validated against read-time geometry and hit-tested across panes and projected separators. Pane clicks focus through a typed command and retain pane-local application or selection ownership through drag/release. Left-dragging captures a generation-safe structural divider and applies each distinct cell position to the real layout and Ghostty surfaces immediately. PaneLayout remains the only current-coordinate owner; Runtime retains one PTY checkpoint behind a 250-ms gate, bounding `SIGWINCH` while preserving live rendering. Release and conflicting transitions converge exactly or fail closed, and decoder work is retained but limited to one geometry-bearing message per session per reactor turn. A normalized vertical wheel report over shell history moves Ghostty's pane-local viewport by one row without entering copy mode; horizontal trackpad reports remain distinct, output preserves the viewport, and accepted application key/paste input returns it to the live area. Status interaction remains absent. |
| Application mouse forwarding | Working | Lemma owns outer button/drag SGR capture independently of child modes, promotes unbuttoned motion only when requested, and uses Ghostty to encode validated pane-local button, wheel, and motion events from the target pane's canonical mouse modes. With no explicit mouse reporting, Ghostty's alternate-screen/alternate-scroll state routes each normalized wheel report as one canonically encoded cursor key. |

Copy/search work is daemon-owned for the one attachment. PTY parsing continues while the viewport is held. Search inspects at most a bounded slice and does not retain a duplicate grid or match list.

## Terminal and presentation

| Capability | Status | Current behavior |
| --- | --- | --- |
| Canonical terminal | Working | Every pane has one `vt::Terminal` backed by pinned `libghostty-vt`. |
| Adapter isolation | Working | Ghostty headers and handles remain private to `lemma_terminal`; public consumers use Lemma types. |
| PTY parse/effects/responses | Working | Output is parsed once; bounded terminal responses are ordered before later accepted input; response overflow or Ghostty VT-processing failure is sticky and fails closed. Bell, title, PWD, progress, notification, clipboard, enquiry, and bounded unknown-sequence effects are explicitly drained and policy-routed; application clipboard writes are denied and unknown sequences dropped by default. |
| Scrollback and reflow | Working | Ghostty owns canonical history, viewport, reflow, and incremental cold-page compression. The default and per-pane hard byte bound match the pinned Ghostty 50,000,000-byte surface default, optional line bounds remain independent, and Runtime admits configured pane capacity against a 3.2-GB daemon aggregate reservation bound. |
| Selection/search/formatting | Working | Adapter wraps tracked selection, viewport, bounded search, formatting, and incremental compression primitives. |
| Damage rendering | Working | Dirty rows/cell spans, grapheme-safe scroll detection, semantic default/indexed colors, distinguishable isolated RGB overrides, cursor, and mode projection emit bounded ANSI. Exact equal-to-default override provenance and transactional OSC 8 hyperlink projection still require narrower Ghostty render APIs. |
| Pane composition | Working | Status, separators, panes, copy highlight/cursor, synchronized output, and focused terminal modes compose server-side. |
| Full reconstruction | Working | Attach, resize, active-tab changes, and lag recovery can force a complete daemon-rendered frame. |
| Slow-client isolation | Working | One retained transaction, bounded write budgets, fair cursor, progress/total deadlines, and full-redraw recovery. |
| Portable terminal replicas/checkpoints | Intentionally absent | The rejected design and evidence are summarized in [`terminal.md`](terminal.md). |
| Graphics and glyph protocol | Disabled | Kitty storage/media/APC and Glyph Protocol advertisement are disabled until bounded canonical presentation support exists. |
| Terminal identity/terminfo | Partial | Child queries receive a consistent Lemma identity, xterm-compatible DA, geometry, color scheme, and `xterm-256color` terminfo name; Lemma still ships no dedicated terminfo entry. |

The current private attached-client protocol is version 2.3. It transports daemon-rendered ANSI, bounded typed key/paste/focus/mouse and pane-resize input, and a bounded client observation of the host default colors and 16-color ANSI palette during attach.

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
