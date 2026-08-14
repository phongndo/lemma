# Current Lemma capabilities

## Audit basis

This inventory was refreshed for the F5 audit from HEAD `b92d0aa` on August 11, 2026. It is based
on source inspection, the release build, 97 GoogleTest component cases, one standalone steady-state
allocation audit, and 22 isolated process-level PTY cases that exercise the real daemon/client/shell
path. F5's 1,000-cycle, compatibility, stress, profile, sanitizer, and soak evidence is tracked
separately because a checked-in harness is not evidence that a long run completed.

This is a current-state document, not a target architecture. The implemented server-rendered ANSI
path, thin client, and private framed protocol are the production direction for the foundational
mux. Deferred daily-driver and automation capabilities remain described in
[`architecture.md`](architecture.md). Product behavior belongs in
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
| Default invocation | Working | Plain `lemma` creates or enters the literal `default` session and visibly fails if it is already attached. |
| Help/version/errors | Working | Dedicated help and version commands exist; invalid commands/arity report diagnostics and return status 2. |
| Machine-readable automation | Absent | There is no `--format=json`, generated semantic schema, immutable snapshot API, or documented compatibility policy. |
| Persistent agent/automation API | Absent | The local attach stream is private framed protocol 1.0, not a public automation API; agents cannot discover typed commands, launch/capture/wait/cancel, subscribe to bounded events, or recover from stale IDs. |
| Per-user daemon | Working | Double-forked daemon, lock file, stale-socket validation, `0600` Unix socket, one listener. |
| Daemon shutdown | Working | `lemma shutdown` warns without mutating sessions; explicit `lemma shutdown --confirm` repeats the warning, stops owned sessions, flushes its response, and unwinds the daemon endpoint. |
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
| cwd/environment policy | Partial | Production creation transports a validated absolute invoking cwd and a bounded 64 KiB/256-entry environment snapshot; all panes inherit that immutable session context and Lemma overrides terminal identity. Splits/new tabs still use the session cwd rather than inspecting the focused process. |
| Child exit cleanup | Working | PTY closure removes the pane; the last pane removes its tab and the last tab removes the session. |
| Restart/reboot durability | Absent | Topology, scrollback, and processes are not persisted across daemon death or reboot. Zstandard is linked but no durable-session snapshot path exists; the planned attach checkpoint is not reboot persistence. |
| Exit-status reporting | Partial | Unexpected session end or connection loss restores the outer terminal, reports a diagnostic, and returns nonzero; exact pane exit status/reason is not yet carried to the client. |

### Tabs

| Capability | Status | Current behavior |
| --- | --- | --- |
| Multiple tabs | Working | Up to 16 generationally identified tabs per session with contiguous, live-reindexed display positions. |
| Create/cycle/select | Working | `C-b c`, `C-b n`, `C-b p`, and `C-b 0`–`9`. |
| Close tab | Working | `C-b &`; closing the final tab ends the session. |
| Active/previous state | Working | Active and previous tabs are retained; inactive tabs continue processing PTY output. |
| Tab listing/status | Working | CLI listing plus a top-row status with a leading session-name block, live position, and focused process title. |
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
| Outer resize | Working | `SIGWINCH` updates the active layout; each pane reserves presentation state, resizes Ghostty, then resizes the PTY and rolls Ghostty geometry back on PTY failure. Too-small layouts are temporarily suspended. |
| Interactive ratios | Absent | Every split is recalculated as an equal half; no keyboard or mouse resizing. |
| Pane IDs/names/overlay | Partial | Internal session/tab/pane/client references use hierarchical generational IDs, and CLI listings expose those textual IDs. The control protocol cannot target them; pane names and an identification overlay remain absent. |
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
| Bracketed paste | Partial | The terminal adapter now exposes bounded Ghostty paste safety/encoding, but the attach protocol still transports legacy bytes, so paste is not yet an opaque typed boundary and prefix routing remains an M3 gap. |
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
| VT parsing/effects | Working | UTF-8/VT input, terminal responses, title changes, bells, modes, reflow, and dirty state are captured behind the adapter. PTY-response overflow is a sticky terminal-integrity failure that retires the pane instead of dropping replies silently. |
| Damage rendering | Working | Dirty rows/cell spans and detected scrolls produce bounded ANSI updates. Effective default, palette, background-only, and focused cursor colors use a session-owned concrete theme and conservative RGB projection. |
| Multi-pane composition | Working | Active panes, separators, status, focused cursor, and outer modes compose into one synchronized frame. Child mode 2026 holds only its pane; a 1 s presentation watchdog restores liveness without clearing canonical mode. |
| Reattach reconstruction | Working | Attach, active-tab change, and resize can force complete visible-state reconstruction through daemon-rendered ANSI. |
| Slow-client isolation | Working | Core-owned initial/live frame writes have partial-write/EAGAIN handling, per-client/global turn budgets, round-robin fairness, one retained transaction, 4 MiB transport chunks, a 64 MiB transaction ceiling, full-redraw recovery, and progress/total deadlines. Deterministic policy tests and a pinned non-reader plus pane-flood latency workload cover isolation. |
| Portable terminal checkpoint export/import | Intentionally absent | The archived feasibility gate proved deterministic counterexamples. Checkpoints and client terminal replicas are not part of the 1.0 architecture. |
| Versioned server-rendered attachment | Working | Private protocol 1.0 frames both directions, validates exact versions and sequences, carries typed disconnects and redraw generations, and bounds incremental decoders and render payloads. |
| Ordinary SSH operation | Partial | Lemma may be run on a remote host through SSH like another terminal program, but no supported compatibility/process/performance suite or remote documentation exists yet. |
| Truthful terminal identity | Partial | Panes advertise `xterm-256color`, `COLORTERM=truecolor`, and `TERM_PROGRAM=lemma`; Lemma ships no terminfo entry or explicit capability policy. |
| Copy access to scrollback | Absent | Ghostty retains scrollback, but Lemma exposes no viewport/traversal/selection API. |
| Graphics protocols | Intentionally disabled | The portable profile does not advertise graphics. Kitty image storage and file/temp-file/shared-memory media are disabled until the qualified replica presentation path exists. |

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
- A fixed-capacity generational session store rejects stale IDs; tabs and pane slots retain
  generations; attached clients receive generations; command targets validate the complete
  session/tab/pane/client hierarchy before mutation. Pending attach reservations retain `SessionId`
  rather than pointers.
- Every dispatched session command is recorded in a bounded deterministic per-session trace with
  its resolved stable target, sequence, and typed result; validation failures observed by the
  dispatcher are traceable as results rather than hidden control flow.
- Client input, accepted connections, control output, PTY reads/writes, attached-client frame writes,
  extension frames, terminal responses, layouts, frame buffers, registration counts, and terminal
  allocations have explicit limits.
- PTYs are drained before client input under a rotating aggregate 256 KiB read budget; terminal
  responses and user input share an ordered per-pane queue; extension IPC is processed after PTY,
  client, queued-write, and frame work.
- Idle setup peers, blocked client frames, and temporarily blocked PTYs do not synchronously stop
  unrelated PTY progress.
- Release-enabled assertions protect internal invariants.
- CI covers `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`; scheduled Linux
  ASan/UBSan exists.
- The current release suite includes 97 GoogleTest component cases, one standalone allocation audit,
  and 22 process-level mux cases. It covers
  IDs/queues, deterministic frame urgency/deadline policy, partial PTY/control/client writes and
  budgets, client progress deadlines, many-client round-robin fairness, flooded-pane full-redraw
  recovery, protocol fragmentation and bounds, key encoding, extension registration/isolation,
  terminal damage/allocation, pane composition, daemon/client lifecycle, complete existing
  focus/zoom/close/tab controls, topology retention, private protocol 1.0 framing and generations,
  resize (including a 500-event flood under output), abrupt disconnect, child exit, restoration,
  malformed/slow setup peers, non-reading initial attach, real blocked-PTY recovery, cross-session
  fairness, and terminal-response/input ordering.
- Benchmarks exist for command dispatch, extension registration codec, VT parsing, damage rendering,
  scroll detection, 1/4/16/64 terminal surfaces in a fixed viewport, warm-session marker
  latency/client bytes, separate key-to-PTY and key-to-visible-frame latency with another session's
  PTY blocked, a non-reading client plus unbounded pane flood, idle CPU/RSS and Darwin wakeup samples,
  and post-workload process-tree RSS/CPU snapshots. Pinned tmux and Zellij adapters run
  the same process inputs and completion markers and preserve incomplete work as explicit failure.

### Important robustness gaps

1. **F5's long-running evidence is not complete.** Finite release tests, compatibility, stress,
   allocation, and 1,000-cycle harnesses exist, but the required 24-hour ASan/UBSan and optimized
   release soaks must remain unfinished until their raw reports exist.
2. **Stable IDs are not yet a public control protocol.** Core state and commands validate
   hierarchical generational session/tab/pane/client targets, and listings expose those IDs
   textually. The private name-oriented control protocol does not accept them as public typed
   targets or return typed stale-ID errors on the wire.
3. **Deferred interaction coverage remains narrow by design.** The foundational harness now measures
   warm-scroll, attach, loaded interaction, blocked-PTY, blocked-client/pane-flood, resize storms,
   pane-profile latency/CPU/bytes/throughput/wakeups/RSS, and mixed-output soaks. Mouse, copy/search,
   and semantic automation are outside the frozen foundation rather than implied F5 features.
4. **User-visible failures are still coarse.** Unexpected attached-client termination now returns
   nonzero after cleanup with a diagnostic, but exact pane exit reasons remain absent and several
   capacity/no-effect outcomes have no attached UI.
5. **The typed command model is not yet a public programmable spine.** Existing C++ commands cover a
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
