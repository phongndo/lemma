# Current Lemma capabilities

## Audit basis

This inventory was established at commit `17bc602` on July 29, 2026, updated after the P0 local mux
closeout, and updated after the August 1 checkpoint Stop and server-rendered architecture decision.
It is based on source inspection, clean builds, 72 component tests, and 12 isolated process-level
PTY tests that exercise the real daemon/client/shell path.

This is a current-state document, not a target architecture. The implemented server-rendered ANSI
path and thin client are now the production direction through 1.0; they still require a versioned
protocol and daily-driver completion described in [`architecture.md`](architecture.md). Product
behavior belongs in
[`product-contract.md`](product-contract.md), the quality bar in
[`daily-driver-contract.md`](daily-driver-contract.md), and outcome/priority guidance in
[`roadmap.md`](roadmap.md).

Status terms:

- **Working:** implemented end to end and exercised by tests or the audit smoke.
- **Partial:** useful implementation or scaffolding exists, but the user-facing path or quality bar is
  incomplete.
- **Absent:** no supported user-facing implementation exists.

## User-facing inventory

### CLI and daemon

| Capability | Status | Current behavior |
| --- | --- | --- |
| Start and attach | Working | `lemma new [name]` ensures the daemon/session exists, then attaches. |
| Start detached | Working | `lemma start [name]` creates a session and prints its listing. |
| Attach/detach | Working | `lemma attach [name]`; `C-b d` detaches without ending pane processes. |
| List/control | Working | List all/one session, list tabs, kill one session, or kill all sessions. |
| Default invocation | Partial | Plain `lemma` prints usage; it does not enter a default session. |
| Help/version/errors | Partial | Usage exists, but there are no dedicated help/version commands and unknown commands return usage rather than a precise failing diagnostic. |
| Machine-readable automation | Absent | There is no `--format=json`, generated semantic schema, immutable snapshot API, or documented compatibility policy. |
| Persistent agent/automation API | Absent | The current local socket is a private unversioned control/attach protocol; agents cannot discover typed commands, launch/capture/wait/cancel, subscribe to bounded events, or recover from stale IDs. |
| Per-user daemon | Working | Double-forked daemon, lock file, stale-socket validation, `0600` Unix socket, one listener. |
| Daemon shutdown | Absent | Session kill commands remove sessions; there is no explicit daemon shutdown/control command. |
| Installable releases | Absent | Users currently build from source; no versioned binary archives or package are produced. |

Session names are 1–32 ASCII letters, digits, underscores, or hyphens. The default explicit
session name is `default`.

### Session and process lifecycle

| Capability | Status | Current behavior |
| --- | --- | --- |
| Multiple sessions | Working | Up to 64 named sessions coexist in one daemon. |
| Detached process continuity | Working | Shells and PTYs remain owned by the daemon when the client detaches or disconnects. |
| Multiple attached clients | Absent | One client may attach to each session; another receives `busy`. |
| Shell launch | Working | Every pane starts the account login shell in a PTY. |
| Arbitrary launch command | Absent | Pane creation cannot currently select a command, cwd, or environment. |
| cwd/environment policy | Partial | New panes inherit the daemon's original cwd/environment, not the invoking client's current context. |
| Child exit cleanup | Working | PTY closure removes the pane; the last pane removes its tab and the last tab removes the session. |
| Restart/reboot durability | Absent | Topology, scrollback, and processes are not persisted across daemon death or reboot. Zstandard is linked but no durable-session snapshot path exists; the planned attach checkpoint is not reboot persistence. |
| Exit-status reporting | Absent | Pane exit status and reason are not presented to the user. |

### Tabs

| Capability | Status | Current behavior |
| --- | --- | --- |
| Multiple tabs | Working | Up to 16 generationally identified numeric tab slots per session. |
| Create/cycle/select | Working | `C-b c`, `C-b n`, `C-b p`, and `C-b 0`–`9`. |
| Close tab | Working | `C-b &`; closing the final tab ends the session. |
| Active/previous state | Working | Active and previous tabs are retained; inactive tabs continue processing PTY output. |
| Tab listing/status | Working | CLI listing plus a centered one-row status with number and focused process title. |
| User names/rename | Absent | Tab labels are numeric and derive titles from the foreground process or terminal title. |
| Reorder/link/move | Absent | Tabs cannot be reordered or linked across sessions. |
| Mouse status selection | Absent | The status row has no hit testing or pointer interaction. |

### Panes and layout

| Capability | Status | Current behavior |
| --- | --- | --- |
| Split panes | Working | `C-b %` splits left/right and `C-b "` splits top/bottom. |
| Nested layout | Working | Bounded binary split tree with one-cell separators and validated non-overlapping rectangles. |
| Focus | Working | Directional arrows, next (`C-b o`), and previous (`C-b ;`). |
| Close pane | Working | `C-b x`; the split tree is compacted and remaining panes are resized. |
| Zoom | Working | `C-b z` toggles the focused pane over the full pane viewport. |
| Outer resize | Working | `SIGWINCH` updates the active layout and PTY sizes; too-small layouts are temporarily suspended. |
| Interactive ratios | Absent | Every split is recalculated as an equal half; no keyboard or mouse resizing. |
| Pane IDs/names/overlay | Absent | Pane storage uses local numeric slots without public generational IDs, names, or an identification overlay. |
| Mouse focus/drag | Absent | No pane hit testing, click-to-focus, or separator dragging. |

The implemented hard limits derive to 64 panes per session and 64 panes in any one tab, with
4,096 panes across the daemon.

### Keyboard, mouse, paste, and copy

| Capability | Status | Current behavior |
| --- | --- | --- |
| Fixed keyboard prefix | Working | Bounded `C-b` parser preserves ordinary input order and times out incomplete escape sequences after 50 ms. |
| Configurable bindings | Absent | Lua keymaps can be registered but are not installed into the client/core path. |
| Semantic key encoding | Partial | Enter, Tab, Backspace, Ctrl-A–Z, arrows, Home, and End are normalized through Ghostty's legacy/Kitty encoder; other bytes pass through unchanged. |
| Extended keyboard input | Partial | The adapter can encode more keys, modifiers, repeats, and Kitty modes, but the attached client does not decode them into typed events. |
| Bracketed paste | Partial | Escape bytes pass through, but paste is not represented as a boundary and the prefix parser does not have paste-specific routing or limits. |
| Focus events | Partial | Focus mode is mirrored in rendered terminal state, but the client has no typed focus-event path. |
| Application mouse input | Unsupported | Mouse modes may be mirrored from the focused app and raw bytes may happen to pass through, but coordinates are not pane-local and split-pane behavior is not correct. |
| Lemma mouse operation | Absent | No typed mouse decoding, status/pane hit testing, selection, scrolling, or drag resizing. |
| Copy/search/selection | Absent | No copy mode, scrollback viewport, search, selection model, or clipboard integration. |

Raw mouse pass-through is not considered a working mouse feature because the core cannot distinguish
Lemma chrome from pane content or translate outer coordinates into the focused pane.

### Terminal emulation and rendering

| Capability | Status | Current behavior |
| --- | --- | --- |
| Canonical terminal state | Working | Each pane owns a `libghostty-vt` terminal with quota-tracked C allocations and an independently capped PagePool scrollback; this is not total-memory accounting. Lemma exposes the pinned implementation's option as `scrollback_bytes_max` because it applies an internal byte limit despite documenting lines. This intentional pre-1.0 source API correction replaced `scrollback_rows_max`; retained row count varies with width. |
| VT parsing/effects | Working | UTF-8/VT input, terminal responses, title changes, bells, modes, reflow, and dirty state are captured behind the adapter. |
| Damage rendering | Working | Dirty rows/cell spans and detected scrolls produce bounded ANSI updates. |
| Multi-pane composition | Working | Active panes, separators, status, focused cursor, and outer modes compose into one synchronized frame. |
| Reattach reconstruction | Working | Attach, active-tab change, and resize can force complete visible-state reconstruction through daemon-rendered ANSI. |
| Slow-client isolation | Working | Initial/live frames and control output flush nonblockingly; idle and non-reading peers are covered by isolated process tests. Broader latency benchmarking remains. |
| Portable terminal checkpoint export/import | Intentionally absent | The archived feasibility gate proved deterministic counterexamples. Checkpoints and client terminal replicas are not part of the 1.0 architecture. |
| Versioned server-rendered attachment | Absent | Current input is bounded but unversioned, daemon ANSI output is unframed, and mismatch/full-redraw epochs are not yet explicit protocol values. |
| Ordinary SSH operation | Partial | Lemma may be run on a remote host through SSH like another terminal program, but no supported compatibility/process/performance suite or remote documentation exists yet. |
| Truthful terminal identity | Partial | Panes advertise `xterm-256color`, `COLORTERM=truecolor`, and `TERM_PROGRAM=lemma`; Lemma ships no terminfo entry or explicit capability policy. |
| Copy access to scrollback | Absent | Ghostty retains scrollback, but Lemma exposes no viewport/traversal/selection API. |
| Graphics protocols | Unspecified | No supported passthrough/rendering contract is documented for terminal graphics. |

### Lua configuration and extensions

| Capability | Status | Current behavior |
| --- | --- | --- |
| Isolated Lua 5.5 host | Working | One child host per daemon loads the XDG/default config with user permissions. |
| Transactional registration | Working | Commands, keymaps, subscriptions, and sidebar declarations are bounded and atomically committed. |
| Failure isolation/restart | Working | Registration IPC is nonblocking and deferred; disconnect clears the generation and schedules restart backoff. |
| Configuration errors | Working | Retained in daemon state, shown by list operations, and reported to the system log. |
| `lemma.setup` settings | Scaffold only | The function accepts a table but currently applies no settings. |
| Command callbacks | Scaffold only | Lua callbacks are retained in the host but cannot be invoked by the daemon. |
| Keymaps | Scaffold only | Registrations reach daemon state but do not affect attached input. |
| Events/snapshots | Scaffold only | Subscription names register; no events or immutable snapshots are delivered. |
| Sidebar UI | Scaffold only | Declarations register; the renderer does not display them. |
| Reload/process/timer/output APIs | Absent | No replacement-host reload or runtime APIs are integrated. |

## Foundation and quality evidence

### What is already strong

- One reactor owns all mutable mux/terminal state.
- Tab IDs reject stale generations; the public ID value type also defines session, pane, and
  client IDs for future stores.
- Client input, accepted connections, control output, PTY writes, extension frames, terminal
  responses, layouts, frame buffers, registration counts, and terminal allocations have explicit
  limits.
- PTYs are drained before client input; terminal responses and user input share an ordered per-pane
  queue; extension IPC is processed after PTY, client, queued-write, and frame work.
- Idle setup peers, blocked client frames, and temporarily blocked PTYs do not synchronously stop
  unrelated PTY progress.
- Release-enabled assertions protect internal invariants.
- CI covers `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`; scheduled Linux
  ASan/UBSan exists.
- The current suite includes 72 component tests and 12 process-level mux tests. It covers
  IDs/queues, deterministic partial PTY/control writes and budgets, protocol fragmentation and
  bounds, key encoding, extension registration/isolation, terminal damage/allocation, pane composition,
  daemon/client lifecycle, complete existing focus/zoom/close/tab controls, topology retention,
  resize, abrupt disconnect, child exit, restoration, malformed/slow setup peers, non-reading initial
  attach, real blocked-PTY recovery, cross-session fairness, and terminal-response/input ordering.
- Benchmarks exist for command dispatch, extension registration codec, VT parsing, damage rendering,
  scroll detection, 1/4/16 terminal surfaces, warm-session marker latency/client bytes, and separate
  key-to-PTY and key-to-visible-frame latency with another session's PTY blocked.

### Important robustness gaps

1. **The production client protocol is unversioned and daemon output is unframed ANSI.** Endpoint
   naming avoids some stale-daemon mismatches, but there is no handshake, typed render envelope,
   full-redraw epoch, typed error set, or independent upgrade diagnostic.
2. **The outer-terminal client lifecycle is not signal-complete.** Normal detach/disconnect performs
   broad escape cleanup and ordinary unwinding restores termios, but fatal/default signals do not
   guarantee those paths execute.
3. **Session and pane IDs are not authoritative stores.** Their public types exist, but core
   commands can only explicitly validate the current tab; session/pane targets remain invalid.
4. **Performance coverage is still narrow.** The checked-in process harness measures warm-scroll
   marker latency/client bytes plus separate key-to-PTY and key-to-visible-frame latency with another
   PTY blocked. Mouse, slow-client distributions, memory-per-pane, resize-storm, and multi-day soak
   harnesses remain absent.
5. **User-visible failures are coarse.** Attached-client loop failures generally return success after
   cleanup, pane exit reasons are absent, and several capacity/no-effect outcomes have no attached UI.
6. **The typed command model is not yet a public programmable spine.** Existing C++ commands cover a
   subset of attached mutations, but there is no schema/introspection, actor/request identity, JSON
   output, persistent semantic socket, bounded capture/wait/cancel, or Lua/agent command parity.

## What the audit establishes

The 1.0 foundation is not greenfield: mux topology, terminal adapter, renderer, daemon, thin client,
and basic keyboard control already form the selected production vertical slice. New work hardens its
identities, protocol, input, UX, configuration, and release behavior without relocating terminal or
presentation authority.

The P0 foundation gate is complete: existing topology behavior is process-tested, accepted peers and
PTY writes have adversarial coverage, blocked PTYs recover exact ordered input without starving
another session, the process benchmark harness is checked in, and the first-release decisions are
recorded.

Remaining work and current priority live only in [`../TODO.md`](../TODO.md); desired outcomes and
release gates live in [`roadmap.md`](roadmap.md).
