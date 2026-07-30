# Current Fiber capabilities

## Audit basis

This inventory describes the executable at commit `17bc602` on July 29, 2026. It is based on source
inspection, a clean debug build, all 60 registered tests, a control-command smoke test, and a
pseudoterminal smoke that created three panes in one window, created a second window, changed window
and zoom state, detached, listed the retained topology, and killed the workspace.

This is a current-state document, not a target architecture. Target behavior belongs in
[`product-contract.md`](product-contract.md), the local quality bar belongs in
[`daily-driver-contract.md`](daily-driver-contract.md), and milestone order belongs in
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
| Start and attach | Working | `fiber new [name]` ensures the daemon/workspace exists, then attaches. |
| Start detached | Working | `fiber start [name]` creates a workspace and prints its listing. |
| Attach/detach | Working | `fiber attach [name]`; `C-b d` detaches without ending pane processes. |
| List/control | Working | List all/one workspace, list windows, kill one workspace, or kill all workspaces. |
| Default invocation | Partial | Plain `fiber` prints usage; it does not enter a default workspace. |
| Help/version/errors | Partial | Usage exists, but there are no dedicated help/version commands and unknown commands return usage rather than a precise failing diagnostic. |
| Per-user daemon | Working | Double-forked daemon, lock file, stale-socket validation, `0600` Unix socket, one listener. |
| Daemon shutdown | Absent | Workspace kill commands remove workspaces; there is no explicit daemon shutdown/control command. |
| Installable releases | Absent | Users currently build from source; no versioned binary archives or package are produced. |

Workspace names are 1–32 ASCII letters, digits, underscores, or hyphens. The default explicit
workspace name is `default`.

### Workspace and process lifecycle

| Capability | Status | Current behavior |
| --- | --- | --- |
| Multiple workspaces | Working | Up to 64 named workspaces coexist in one daemon. |
| Detached process continuity | Working | Shells and PTYs remain owned by the daemon when the client detaches or disconnects. |
| Multiple attached clients | Absent | One client may attach to each workspace; another receives `busy`. |
| Shell launch | Working | Every pane starts the account login shell in a PTY. |
| Arbitrary launch command | Absent | Pane creation cannot currently select a command, cwd, or environment. |
| cwd/environment policy | Partial | New panes inherit the daemon's original cwd/environment, not the invoking client's current context. |
| Child exit cleanup | Working | PTY closure removes the pane; the last pane removes its window and the last window removes the workspace. |
| Restart/reboot durability | Absent | Topology, scrollback, and processes are not persisted across daemon death or reboot. Zstandard is linked but no snapshot path exists. |
| Exit-status reporting | Absent | Pane exit status and reason are not presented to the user. |

### Windows

| Capability | Status | Current behavior |
| --- | --- | --- |
| Multiple windows | Working | Up to 16 generationally identified numeric window slots per workspace. |
| Create/cycle/select | Working | `C-b c`, `C-b n`, `C-b p`, and `C-b 0`–`9`. |
| Close window | Working | `C-b &`; closing the final window ends the workspace. |
| Active/previous state | Working | Active and previous windows are retained; inactive windows continue processing PTY output. |
| Window listing/status | Working | CLI listing plus a centered one-row status with number and focused process title. |
| User names/rename | Absent | Window labels are numeric and derive titles from the foreground process or terminal title. |
| Reorder/link/move | Absent | Windows cannot be reordered or linked across workspaces. |
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

The implemented hard limits derive to 64 panes per workspace and 64 panes in any one window, with
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
| Fiber mouse operation | Absent | No typed mouse decoding, status/pane hit testing, selection, scrolling, or drag resizing. |
| Copy/search/selection | Absent | No copy mode, scrollback viewport, search, selection model, or clipboard integration. |

Raw mouse pass-through is not considered a working mouse feature because the core cannot distinguish
Fiber chrome from pane content or translate outer coordinates into the focused pane.

### Terminal emulation and rendering

| Capability | Status | Current behavior |
| --- | --- | --- |
| Canonical terminal state | Working | Each pane owns a quota-tracked `libghostty-vt` terminal with 10,000 default scrollback rows. |
| VT parsing/effects | Working | UTF-8/VT input, terminal responses, title changes, bells, modes, reflow, and dirty state are captured behind the adapter. |
| Damage rendering | Working | Dirty rows/cell spans and detected scrolls produce bounded ANSI updates. |
| Multi-pane composition | Working | Active panes, separators, status, focused cursor, and outer modes compose into one synchronized frame. |
| Reattach reconstruction | Working | Attach, active-window change, and resize can force complete visible-state reconstruction. |
| Slow-client isolation | Partial | One bounded frame can be in flight while PTYs continue, but broader backpressure and fairness scenarios lack end-to-end stress coverage. |
| Truthful terminal identity | Partial | Panes advertise `xterm-256color`, `COLORTERM=truecolor`, and `TERM_PROGRAM=fiber`; Fiber ships no terminfo entry or explicit capability policy. |
| Copy access to scrollback | Absent | Ghostty retains scrollback, but Fiber exposes no viewport/traversal/selection API. |
| Graphics protocols | Unspecified | No supported passthrough/rendering contract is documented for terminal graphics. |

### Lua configuration and extensions

| Capability | Status | Current behavior |
| --- | --- | --- |
| Isolated Lua 5.5 host | Working | One child host per daemon loads the XDG/default config with user permissions. |
| Transactional registration | Working | Commands, keymaps, subscriptions, and sidebar declarations are bounded and atomically committed. |
| Failure isolation/restart | Working | Registration IPC is nonblocking and deferred; disconnect clears the generation and schedules restart backoff. |
| Configuration errors | Working | Retained in daemon state, shown by list operations, and reported to the system log. |
| `fiber.setup` settings | Scaffold only | The function accepts a table but currently applies no settings. |
| Command callbacks | Scaffold only | Lua callbacks are retained in the host but cannot be invoked by the daemon. |
| Keymaps | Scaffold only | Registrations reach daemon state but do not affect attached input. |
| Events/snapshots | Scaffold only | Subscription names register; no events or immutable snapshots are delivered. |
| Sidebar UI | Scaffold only | Declarations register; the renderer does not display them. |
| Reload/process/timer/output APIs | Absent | No replacement-host reload or runtime APIs are integrated. |

## Foundation and quality evidence

### What is already strong

- One reactor owns all mutable mux/terminal state.
- Window IDs reject stale generations; the public ID value type also defines workspace, pane, and
  client IDs for future stores.
- Client input, extension frames, terminal responses, layouts, frame buffers, registration counts,
  and terminal allocations have explicit limits.
- PTYs are drained before client input; extension IPC is processed after PTY, client, and frame work.
- A blocked client frame does not synchronously stop PTY reads.
- Release-enabled assertions protect internal invariants.
- CI covers `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`; scheduled Linux
  ASan/UBSan exists.
- The current 60 tests passed during this audit. They cover IDs/queues, protocol fragmentation and
  bounds, key encoding, extension registration/isolation, terminal damage/allocation, and pane
  composition.
- Benchmarks exist for command dispatch, extension registration codec, VT parsing, damage rendering,
  scroll detection, and 1/4/16 terminal surfaces.

### Important robustness gaps

1. **Accepted control/setup connections are blocking.** The reactor calls blocking `read_exact` and
   initial frame sends after `accept`. A peer that connects and stops can block PTY progress, contrary
   to the target invariant. Accepted connections need bounded incremental nonblocking state.
2. **PTY writes are not queued.** Client input and terminal responses use `write_all` against a
   nonblocking PTY. `EAGAIN` currently becomes an error instead of bounded backpressure, potentially
   detaching the client or retiring a pane.
3. **There is no automated process-level mux test.** Unit/component tests do not currently launch the
   daemon/client together to protect attach, split, window, detach, reattach, process exit, and
   restoration behavior. The audit pseudoterminal smoke was manual.
4. **The client protocol is unversioned.** Endpoint-name changes avoid some stale-daemon mismatches,
   but there is no handshake, capabilities, typed errors, or independent upgrade path.
5. **Terminal restoration is not signal-complete.** Normal detach/disconnect performs broad escape
   cleanup and the raw-mode object restores termios during ordinary unwinding, but fatal/default
   signals do not guarantee those paths execute.
6. **Workspace and pane IDs are not authoritative stores.** Their public types exist, but core
   commands can only explicitly validate the current window; workspace/pane targets remain invalid.
7. **Performance coverage is narrow.** Existing measurements are promising, but there are no checked-in
   key-to-PTY, key-to-frame, mouse, slow-client, memory-per-pane, resize-storm, or multi-day soak
   harnesses. The documented warm-mux comparison harness is not in the repository.
8. **User-visible failures are coarse.** Attached-client loop failures generally return success after
   cleanup, pane exit reasons are absent, and several capacity/no-effect outcomes have no attached UI.

## What the audit means for phase one

Phase one is not greenfield: the mux topology, terminal adapter, renderer, daemon, and basic keyboard
control already form a working vertical slice. It should preserve that behavior while closing the
reactor and test-harness gaps before adding broad features.

The derived order is:

1. Check in a process-level pseudoterminal integration harness that protects today's create, attach,
   input, split, focus, window, zoom, detach, reattach, child-exit, and cleanup behavior.
2. Replace blocking accepted-connection setup/control handling with bounded incremental nonblocking
   state and tests for idle/malicious peers.
3. Add bounded PTY write queues for user input and terminal responses, with explicit overflow and
   fairness behavior.
4. Introduce authoritative workspace/pane IDs and the generalized versioned protocol.
5. Build ordered typed keyboard, paste, focus, resize, and mouse input over that protocol.
6. Deliver the first shared semantic interaction: keyboard focus plus mouse click-to-focus and
   correct application mouse pass-through/restoration.
7. Continue into names, interactive resize, copy/search/selection, and installable alpha artifacts.
