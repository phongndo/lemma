# Current capabilities

## Audit basis

Audited from the current source, public headers, CMake targets, tests, and checked-in benchmark tooling. Only implemented facts are included.

Status terms:

- **Working** — implemented end to end with direct test coverage.
- **Partial** — useful implementation exists, but the supported path or behavior is incomplete.
- **Absent** — no supported user-facing implementation exists.

## Current architecture

Lemma is one C++23 executable with client, daemon, extension-host, and control roles. A per-user daemon runs one `poll`-based reactor. The `lemma_core` target owns only semantic commands and the Session/Tab/Pane/Attachment model; `lemma_runtime` owns reactor and external-resource mechanics.

A daemon-owned input-policy component compiles the built-in prefix and transient-resize keymap into bounded context and binding tables. Each attached Session record owns one direct per-Attachment router state; those physical bindings and named contexts remain outside mux Core and route only to typed commands or application input. Copy/search keeps its existing native semantic action table in this implementation slice; Lua keymap generations are not yet active.

The current in-memory hierarchy is `Session -> Tab -> Pane`, with separate semantic and runtime counterparts:

- `Pane` contains one Session-scoped `PaneId`, owning `TabId`, committed layout geometry, indirect exact launch argv, exit policy, and an optional committed process outcome. A separate bounded runtime store resolves the direct generational `SessionId -> PaneId` address to one `PaneRuntime` without presentation-derived lookup.
- `PaneRuntime` owns the child PID, PTY descriptor, `vt::Terminal`, PTY write queue, presentation gate, process-title refresh state, compression scheduling, trace state, observed pre-commit child outcome, typed failure state, and teardown. Staged creation publishes the semantic pane and runtime counterpart together; Runtime reports failure or exit to Core, which closes the pane or retains its canonical terminal under explicit hold policy.
- `Tab` owns a binary layout tree referencing Session pane IDs, geometry, focus, previous focus, a bounded optional title override, zoom, and suspension state. Layout topology and resize candidates are planned separately, applied transactionally to PaneRuntimes, and committed to semantic geometry only after Runtime succeeds.
- `Session` owns identity, bounded launch context, Session-scoped generational pane slots, generational tab slots, one private bounded `TabOrder` permutation, active/previous tab, lifecycle, and theme-binding policy. Its destructor performs no I/O.
- `Attachment` owns the stable semantic relationship to one Session, viewport geometry, copy policy, bounded rename-editor state, and a fully scoped generational pane or split-divider mouse capture target. Current single-controller policy creates one Attachment per Session.
- `AttachmentRuntime` owns the replaceable connection descriptor, decoder, retained frame and output progress, protocol generations, copy/search continuation, clipboard staging, deadlines, backpressure, presentation caches, trace state, and teardown.
- Runtime stores one direct aggregate record per Session. Session, Attachment, and AttachmentRuntime retain stable addresses with no extra connection lookup, allocation, virtual dispatch, or shared ownership on hot paths.

The target ownership model is in [`architecture.md`](architecture.md).

## CLI, daemon, and lifecycle

| Capability | Status | Current behavior |
| --- | --- | --- |
| Default invocation | Working | Plain `lemma` strictly creates a fresh numerically named session and attaches. Unnamed creation allocates the lowest available nonnegative numeric name atomically in the daemon. |
| Session lifecycle | Working | Plain `lemma` creates and attaches; omitted `attach` targets the most recently active detached session. Common Session operations remain noun-free as top-level `new`, `start`, `attach`, `list`/`ls`, `inspect`, `rename`, and `kill` commands. `lemma action session ...` provides the complete structured lifecycle surface, including stable ID selectors. Top-level `lemma tab ...` and `lemma pane ...` command families are absent. Creation supports cwd, `--hold`, exact argv, strict duplicate handling, and names. Attachment-owned inline status editors rename the current session (`C-b R`) or tab (`C-b r`) without leaving the mux. |
| Daemon lifecycle | Working | Session creation starts the per-user daemon automatically and the daemon exits after its final session ends. Destructive daemon shutdown remains a private development mechanism rather than public CLI grammar. |
| Agent skill | Working | `skill` prints a version-matched single-file Agent Skills guide without contacting the daemon. |
| Help/version/errors | Working | Dedicated output and nonzero invalid-command behavior exist. |
| Per-user daemon | Working | Owner-only Unix socket, lock, stale-socket checks, daemonization, and cleanup. |
| Detach continuity | Working | Client detach/EOF does not end pane processes while the daemon remains alive. |
| Restart/reboot durability | Absent | Process, topology, terminal, and scrollback state are not persisted across daemon death. |
| Multiple viewers/controllers | Absent | One attached client is allowed per session. |
| Machine-readable semantic API | Working | The owner-only per-user Unix endpoint accepts persistent lock-step `lemma.action/v1` Action RPC and `lemma.proc/v1` Proc RPC. Both use one daemon-owned Action executor and canonical nested results. Proc validates up to 64 ordered Actions and typed backward references before side effects. `lemma action` and `lemma proc` are shell frontends; persistent agents normally use the connection directly. `api schema --json` prints the embedded JSON Schema 2020-12 contract offline. |
| Installable release artifacts | Working | The Nix flake exposes the default release package as `lemma` and a separate debug package as `delemma`. |

Session names are unique 1–32 ASCII letters, digits, underscores, or hyphens and may not begin with a hyphen; the inline editor silently ignores unsupported characters and excess input. Tab title overrides are empty (derived process/terminal title) or 1–64 printable ASCII bytes. The daemon admits up to 64 sessions.

## Tabs, panes, and layout

| Capability | Status | Current behavior |
| --- | --- | --- |
| Tabs | Working | Up to 16 tabs per session; create with exact argv/cwd/exit policy, cycle, numeric or CLI select, list, close, stable absolute CLI placement or relative key reorder (`C-b P`/`C-b N`), and bounded title override. Display order is one Session-owned permutation independent of stable IDs and storage slots. |
| Split panes | Working | Nested left/right and top/bottom binary splits, up to 64 panes per session and 4,096 daemon-wide. `lemma action pane split` targets a stable pane ID and accepts exact argv, explicit cwd, and `--hold`. New tab/split processes use the Session's captured environment and creation cwd unless an explicit cwd is supplied. |
| Focus/close/zoom | Working | Directional/next/previous focus, close, and zoom use generational pane IDs. `lemma action pane focus/swap/resize/zoom/kill` and interactive input converge on the typed command dispatcher. |
| Resize | Working | Outer-window resize samples coalesce to one settled endpoint after a 50-ms quiet interval, or immediately before subsequent user input. The daemon then resolves the active layout and coordinates Ghostty/PTY resize with rollback/fail-closed behavior. |
| Inactive output | Working | Inactive tabs continue draining and parsing PTY output. |
| Status | Working | A top row renders the session as a bold reverse-video block, followed by an ASCII ` | ` boundary and left-aligned tabs; the active tab is bold and framed as `[ <position>:<title> ]`. A trailing ASCII `+` creates a tab when capacity allows. Inactive tabs retain contiguous positions and bounded manual-or-process-derived titles. Presentation uses only the terminal's default colors plus standard ANSI attributes. Clearing a manual title resumes derivation. Copy mode preserves those titles and projects its position or search feedback as a bounded top-right pane overlay. |
| Stored ratios and interactive resize | Working | Every branch owns a bounded fixed-point ratio. `C-b Ctrl-h/j/k/l` or `C-b Alt-h/j/k/l` moves the nearest matching structural divider by one cell. Dragging a projected separator resizes and reflows the real pane surfaces live; release converges child PTYs exactly at the final clamped pointer position. Ratios survive outer resize, zoom, tab changes, detach, and reattach. |
| Rename/reorder | Working | Attachment-owned bounded inline status editors and `lemma action session/tab rename` rename sessions/tabs; cyclic relative tab reorder and mouse drag release use typed stable-ID commands. A tab drag retains only a stable source and `place before` anchor in Attachment-owned gesture state: motion projects a live non-authoritative order while keeping each whole label and pre-drop position prefix together, then release commits the real Session-owned `TabOrder` and renumbers the labels. The edited identity stays in its normal position with surrounding context: session input remains inside the reverse-video session block and active-tab input remains inside `[ <position>:<title> ]`; the fixed inner spaces hold the steady bar cursor without changing either block's length, and only entered characters are underlined. Validation feedback appears at the right only when needed. Duplicate session names remain editable with explicit feedback and no mutation. |
| Pane swap | Working | `C-b Shift-h/j/k/l` swaps the focused pane with its spatial neighbor in that direction while preserving layout shape and ratios. Focus and swap use the same bounded directional scoring. |
| Pane move between tabs or sessions | Deferred | Moving panes out of their tab has no command or default binding. Session launch, theme, attachment, and process-lifecycle ownership is not crossed. |
| Pane automation | Working | `lemma action pane list/send/capture` targets stable IDs and returns canonical Action results. `lemma events` exposes filtered initial snapshots plus coalesced semantic, process, and optional plain-text screen updates as NDJSON. Waiting and streaming are observation concerns rather than Proc Actions. Semantic key/paste input and historical capture/search are not yet exposed. |
| Held process outcome | Working | `--hold` on session, tab, or split creation keeps the canonical terminal and typed exit code/signal after PTY EOF. Held panes reject input, remain capturable/resizable, consume ordinary pane/terminal capacity, and keep their session and daemon alive until killed. |
| Pane identification UI | Partial | IDs appear in listings, creation results, procedure results, and typed command targets, but there is no pane overlay or naming UX. |

Session, tab, pane, semantic Attachment, and runtime connection references use distinct generational IDs internally. Concrete Actions carry explicit Session selectors and stable Session-scoped Tab/Pane IDs. Each pane child receives its current Session, Tab, and Pane IDs for CLI context inference. Proc references exist only during daemon-side whole-plan validation and resolution.

## Input, copy, and mouse

| Capability | Status | Current behavior |
| --- | --- | --- |
| Compiled keymap and input contexts | Working | The daemon routes a bounded compiled built-in keymap; the client only decodes and transports physical input. `C-b` is a one-shot context, `C-b C-b` sends a literal prefix, and `C-b m` enters a visible transient resize context where `h/j/k/l` or arrows resize repeatedly and `q`, Escape, or Enter exits. Existing one-shot bindings remain: `C-b h/j/k/l` focuses, `C-b Shift-h/j/k/l` swaps, `C-b Ctrl-h/j/k/l` or `C-b Alt-h/j/k/l` resizes, `C-b R`/`r` renames, `C-b P`/`N` reorders tabs, and `C-b /`/`?` enters copy search. The compiled default map binds `Super+c`/`Ctrl+Shift+c` to copy in every context and `Super+Left`/`Super+Right` to encode as Home/End in the base and prefix contexts. A replacement compiled map can omit or rebind those chords. |
| Key encoding | Working | The client requests Kitty disambiguation, event, alternate-key, and associated-text metadata without requesting `report all keys`; layout and IME text therefore remains ordinary text on hosts that omit associated text. Typed metadata is preserved and Ghostty encodes it against each pane's active modes. Releases do not emit fallback text. Compiled `encode_as` bindings may translate a physical chord to another application key before encoding, including the matching release. |
| Typed paste/focus | Working | Outer bracketed-paste and focus reporting are enabled while attached. Reports are decoded across arbitrary read fragmentation, transported as bounded typed messages, and encoded from canonical Ghostty modes. Paste remains one opaque event up to 1 MiB and bypasses mux-prefix interpretation. |
| Copy mode | Working | Typed Vim-shaped navigation (`h/j/k/l`, words, line/history/viewport, half/full-page, arrows), character/line/block Visual selection, endpoint swapping, tracked pane-local mouse selection, incremental wrapping literal search from the copy cursor with central-context match placement, viewport hold, a pane-local position overlay, and OSC 52 user copy are integrated. `y`/Enter copy the copy-mode selection and leave copy mode. `Super+c`/`Ctrl+Shift+c` copy a copy-mode or mouse selection; a mouse highlight stays visible after copy, matching Ghostty's default `selection-clear-on-copy=false`. With no selection those chords are performable misses and forward in the base context. Application key or byte input clears a mouse highlight only when it enqueues PTY bytes. |
| Native clipboard | Absent | Copy output relies on bounded user-initiated OSC 52. |
| Mouse mux operation | Working | SGR mouse input is validated against read-time geometry and hit-tested across the shared status projection, panes, and projected separators. A left press on a visible tab label selects its stable Tab ID through the typed command path; dragging updates an Attachment-owned live ordering preview and release commits one stable `place_tab` command. The trailing `+` dispatches the existing typed create-tab command. Session cells, separators, spacing, overflow markers, prompts, and hidden tabs are not targets, and each status gesture retains ownership through release so it cannot leak into a child. Pane clicks focus through a typed command and retain pane-local application or selection ownership through drag/release. Left-dragging captures a generation-safe structural divider and applies each distinct cell position through the same rollback-capable PTY-first terminal resize transaction as other geometry changes. `PaneLayout` remains the only current-coordinate owner; Ghostty never parses at dimensions not already reported to the child PTY. Decoder work is retained but limited to one geometry-bearing message per session per reactor turn. A normalized vertical wheel report over shell history moves Ghostty's pane-local viewport by one row without entering copy mode; horizontal trackpad reports remain distinct, output preserves the viewport, and accepted application key/paste input returns it to the live area. |
| Application mouse forwarding | Working | Lemma owns outer button/drag SGR capture independently of child modes, promotes unbuttoned motion only when requested, and uses Ghostty to encode validated pane-local button, wheel, and motion events from the target pane's canonical mouse modes. With no explicit mouse reporting, Ghostty's alternate-screen/alternate-scroll state routes each normalized wheel report as one canonically encoded cursor key. |

Copy/search work is daemon-owned for the one attachment. PTY parsing continues while the viewport is held. Search inspects at most a bounded slice and does not retain a duplicate grid or match list.

## Terminal and presentation

| Capability | Status | Current behavior |
| --- | --- | --- |
| Canonical terminal | Working | Every pane has one `vt::Terminal` backed by pinned `libghostty-vt`. |
| Adapter isolation | Working | Ghostty headers and handles remain private to `lemma_terminal`; public consumers use Lemma types. |
| PTY parse/effects/responses | Working | Output is parsed once; bounded terminal responses are ordered before later accepted input; response overflow or Ghostty VT-processing failure is sticky and fails closed. Bell, title, PWD, progress, notification, clipboard, enquiry, and bounded unknown-sequence effects are explicitly drained and policy-routed; application clipboard writes are denied and unknown sequences dropped by default. Enabling mode 2048 emits an immediate in-band size report, and later Ghostty resizes emit an updated report through the pane's ordered PTY write queue. Pixel fields are the pane terminal's current cell metrics; the attach protocol does not transport host cell size, so those fields remain zero until a later host-geometry contract exists. |
| Scrollback and reflow | Working | Ghostty owns canonical history, viewport, reflow, and incremental cold-page compression. The default and per-pane hard byte bound match the pinned Ghostty 50,000,000-byte surface default, optional line bounds remain independent, and Runtime admits configured pane capacity against a 3.2-GB daemon aggregate reservation bound. |
| Selection/search/formatting | Working | Adapter wraps tracked selection, viewport, bounded search, formatting, and incremental compression primitives. |
| Damage rendering | Working | Dirty rows/cell spans, grapheme-safe scroll detection, semantic default/indexed colors, distinguishable isolated RGB overrides, cursor, and mode projection emit bounded ANSI. Exact equal-to-default override provenance and transactional OSC 8 hyperlink projection still require narrower Ghostty render APIs. |
| Pane composition | Working | Status, separators, panes, copy highlight/cursor, synchronized output, and focused terminal modes compose server-side. |
| Full reconstruction | Working | Attach, resize, active-tab changes, and lag recovery can force a complete daemon-rendered frame. |
| Slow-client isolation | Working | One retained transaction, bounded write budgets, fair cursor, progress/total deadlines, and full-redraw recovery. |
| Portable terminal replicas/checkpoints | Intentionally absent | The rejected design and evidence are summarized in [`terminal.md`](terminal.md). |
| Graphics and glyph protocol | Disabled | Kitty storage/media/APC and Glyph Protocol advertisement are disabled until bounded canonical presentation support exists. |
| Terminal identity/terminfo | Partial | Child queries receive a consistent Lemma identity, xterm-compatible DA, geometry, color scheme, and `xterm-256color` terminfo name; Lemma still ships no dedicated terminfo entry. |

The current private attached-client protocol is version 2.9. It transports daemon-rendered ANSI, bounded typed key/paste/focus/mouse and pane-resize input, and a bounded client observation of the host default colors, optional OSC 17/19 highlight colors, and 16-color ANSI palette during attach. Public machine control and observation use the separate versioned JSON contracts documented in [`control-api.md`](control-api.md). Selected cells are painted with those highlight colors, or a bg-toward-fg mix that keeps cell foregrounds, instead of reverse video.

## Configuration and extensions

| Capability | Status | Current behavior |
| --- | --- | --- |
| Isolated Lua 5.5 host | Working | An explicit config starts one managed child process with a 16 MiB Lua allocation quota. |
| No-config path | Working | No extension runtime or Lua process is created when configuration is absent. |
| Transactional registration | Working | Bounded command, keymap, event-subscription, and sidebar declarations commit as a generation. |
| Crash/block isolation | Working foundation | IPC is nonblocking and processed after critical reactor work; disconnect clears the generation and schedules restart. |
| Settings applied to mux | Absent | `lemma.setup` does not currently alter product settings. |
| Lua command callbacks/keymaps | Absent from user path | Registrations are retained but are not yet compiled into the active input-policy generation and do not drive attached commands. |
| Snapshots/events/UI/process APIs/reload | Absent | No complete runtime integration exists. |

## Testing and measurement present today

The build defines component tests, isolated real-process PTY tests, a standalone steady-state allocation audit, terminal/render/core/protocol benchmarks, memory census tooling, and Lemma/tmux/Zellij/Herdr comparison drivers. The process harness also measures 1/4/16 logical workspaces and named sessions so one-daemon and one-server-per-unit models are not conflated. CI covers formatting, build/tests, clang-tidy, clangd, Linux ASan/UBSan, workflow/script checks, and scheduled host matrices.

Measured evidence and caveats are in [`performance.md`](performance.md) and [`memory.md`](memory.md). Test existence does not imply every product capability in [`product-contract.md`](product-contract.md) is implemented.
