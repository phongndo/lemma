# Fiber daily-driver contract

## Purpose

Fiber must become an excellent day-to-day terminal multiplexer on one architecture used locally and
remotely. SSH transport and reconnect correctness are validated with the replication foundation so
local assumptions do not harden into the protocol; multiplayer, agents, and broad remote UX remain
later differentiators. This document defines the quality gate. It is narrower than feature parity
with tmux or Zellij and stronger than merely having a code path for each feature.

Current implementation status is documented in
[`single-pane-runtime.md`](single-pane-runtime.md). Milestone order is documented in
[`roadmap.md`](roadmap.md).

## Completion rule

A feature is complete only when all applicable parts exist:

1. documented user behavior and failure behavior;
2. keyboard access and first-class mouse behavior where spatial interaction applies;
3. one typed semantic command/state path rather than duplicated mutations;
4. explicit ownership, capacity, queue, payload, and per-turn work bounds;
5. unit, integration, malformed-input, cleanup, and capacity tests;
6. a benchmark or trace when the feature touches input, PTY, rendering, layout, or protocol hot
   paths; and
7. user documentation and discoverable errors.

A partial feature must remain labeled experimental or incomplete. Later roadmap milestones do not
bypass this gate to accumulate more surface area.

## Required local mux behavior

### Startup and session lifecycle

- Plain `fiber` has a predictable zero-configuration behavior.
- Named workspaces can be created, listed, attached, detached, renamed, and killed.
- Client EOF, crash, terminal closure, or network loss does not end workspace processes.
- Child exit, shell launch failure, capacity exhaustion, stale sockets, and incompatible clients
  produce actionable errors.
- Detach, logout, daemon failure, and reboot guarantees are explicit and tested; Fiber does not imply
  process survival where the architecture cannot provide it.
- Endpoint permissions and ownership prevent another local user from controlling a daemon.

### Windows

- Create, close, rename, list, directly select, and cycle windows.
- Reorder windows without invalidating stable external identities.
- Preserve per-window layout, focused pane, zoom state, and foreground-process title.
- Keep the active window visible in bounded status output at narrow widths.
- Provide keyboard selection and direct mouse selection through the same command dispatcher.

### Panes and layouts

- Split left/right and top/bottom, close, zoom, and focus by direction or order.
- Resize panes incrementally with the keyboard and by dragging separators with the mouse.
- Preserve valid minimum sizes and deterministic ratios across client resize.
- Resolve nested layouts without overlap, gaps, invalid focus, or unbounded traversal.
- Make pane targeting visible through status, borders, or a bounded identification overlay.
- Handle child exit without corrupting the remaining split tree.

Preset layouts, pane swapping, and moving panes between windows are desirable only after these core
operations are dependable.

### Keyboard, mouse, paste, and focus

- Keyboard-only operation covers every core mux command and copy workflow.
- Normal text, Unicode, control keys, Alt combinations, function/navigation keys, legacy mode, and
  negotiated extended-key input reach applications correctly.
- Prefix handling preserves ordering, has bounded incomplete-sequence behavior, and always provides a
  way to send a literal prefix.
- Bracketed paste preserves boundaries, applies explicit size/backpressure policy, and is never
  mistaken for mux commands.
- Mouse click, release, motion/drag, and wheel events are decoded into bounded typed values.
- The smart client hit-tests its status, separators, overlays, selection, and pane presentation and
  emits semantic commands with stable targets.
- Application events carry a validated pane ID and pane-local cells and are encoded by the daemon
  according to canonical terminal mouse modes.
- A configurable modifier overrides application mouse capture for Fiber interaction.
- Focus reporting is forwarded only when requested by the focused application.
- Client startup and every exit path restore raw mode, cursor state, alternate screen, paste, focus,
  keyboard, and mouse modes exactly.

### Copy, search, selection, and clipboard

- The smart client owns per-replica viewport, copy cursor, search, selection, and follow-output state;
  one client's view never mutates another client's canonical terminal or viewport.
- Enter and leave copy mode without stopping PTY progress or losing new scrollback.
- Navigate available scrollback, pages, lines, words, and buffer boundaries with the keyboard while
  bounded missing history hydrates progressively from the daemon.
- Select by character, word, and line with keyboard and mouse paths sharing one client-local model.
- Search forward/backward incrementally with bounded state and visible no-match/loading behavior.
- Copy plain text predictably across wrapped lines, wide cells, grapheme clusters, and rectangular
  pane boundaries.
- Integrate with the platform clipboard through an explicit security policy; OSC 52 behavior is
  configurable and bounded by daemon policy and client consent.
- Define wheel behavior separately for normal scrollback, alternate screen, copy mode, missing
  history, and applications that request mouse tracking or alternate scroll.

### Terminal replication, compatibility, and rendering

- Correctly handle UTF-8, grapheme clusters, combining marks, wide cells, true color, supported text
  styles, cursor shapes, tab stops, wrapping, scroll regions, and resize reflow through authoritative
  and replica terminal adapter roles.
- A bounded versioned checkpoint at sequence `N` plus every ordered event after `N` produces the same
  observable terminal state as uninterrupted parsing across arbitrary chunk and parser boundaries.
- Only the daemon emits terminal query responses and applies authoritative side-effect policy;
  replicas suppress those outputs.
- Attach presents visible state before progressive history, and lag/reconnect recover through bounded
  resume or a fresh checkpoint without stopping PTYs.
- Support alternate screen, synchronized updates, bracketed paste, focus events, hyperlinks, title
  changes, and terminal queries without leaking pane modes into Fiber-owned chrome.
- Ship or select truthful terminfo and `$TERM` behavior rather than advertising unsupported
  capabilities.
- Client presentation composes replicas, separators, status, overlays, cursor, and terminal modes
  without visible partial-topology updates. ANSI compatibility and native rendering consume the same
  replica model.
- Reconstruct complete visible state after attach, active-window change, resize, client lag, and
  reconnect.
- Document unsupported protocols such as graphics instead of silently corrupting or discarding them.

### Configuration

- Missing configuration selects useful defaults.
- Invalid configuration reports file/line context and preserves the previous valid generation.
- Prefixes, keyboard bindings, mouse bindings, basic status behavior, shell, and default workspace
  behavior are configurable through typed validated values.
- Reload is transactional; blocked or crashed Lua cannot block input, PTY progress, rendering, or
  process lifetime.
- `fiber --help` and generated command/binding references are sufficient to discover core operation.

### Installation and upgrades

- Users install signed or checksummed macOS/Linux artifacts without compiling dependencies.
- Version output identifies Fiber, protocol, build mode, and relevant private dependency revisions.
- Client/daemon mismatches fail with an upgrade/restart instruction rather than wire corruption.
- Upgrade notes identify configuration, protocol, state, or behavior changes.
- Uninstall and daemon cleanup are documented and do not silently kill unexpected processes.

## Performance contract

Performance is a user-facing feature and is measured end to end. The daily-driver benchmark suite
must cover distributions and resource use, not only best-case throughput:

- key-to-PTY and key-to-visible-frame latency at idle and during output load;
- mouse click-to-focus, drag-to-layout, wheel-to-scroll, and application pass-through latency;
- sparse editor updates, full-screen redraws, synchronized updates, and high-scroll output;
- one, four, sixteen, and maximum configured pane layouts;
- active and inactive windows, attach reconstruction, resize storms, and status changes;
- slow/blocked clients and extension hosts;
- idle CPU/wakeups, daemon baseline memory, incremental memory per pane/client, and peak bounded
  queues; and
- bytes written to clients alongside latency so coalescing does not hide excessive bandwidth.

The suite additionally covers checkpoint bytes/export/import time, attach-to-ready, event-to-visible
latency, acknowledgement lag, forced-resynchronization time, progressive-history bytes/time, and the
same core workloads over local Unix and shaped SSH transports. It records both daemon and client CPU
and memory so moving work to clients is not mislabeled as eliminating it.

The suite records p50, p95, and p99 where the harness supports enough samples. Stable benchmarks gain
reviewed regression budgets; a regression outside budget requires explanation and evidence rather
than a language-level assumption that the path is fast. Release results remain hardware-, transport-,
presentation-, and workload-labeled.

Hot-path invariants from [`architecture.md`](architecture.md) and
[`performance.md`](performance.md) continue to apply: no synchronous extension waits, no slow-client
PTY stalls, bounded sequencing/checkpoint/history work per turn, bounded replica/render work, and no
accidental general-heap use in steady-state event processing.

## Robustness contract

The daily-driver gate requires:

- unit and property tests for IDs, split trees, hit testing, selection, key/mouse decoding, commands,
  framing, and bounds;
- pseudoterminal integration tests for launch, input, paste, mouse modes, resize, detach/attach,
  child exit, and terminal restoration;
- protocol fragmentation, coalescing, malformed, oversized, flood, and mismatch tests;
- checkpoint-plus-tail equivalence, transactional import, duplicate/missing/out-of-order event,
  acknowledgement, resume, forced reset, and progressive-history tests;
- fuzz coverage for untrusted client framing, checkpoint import, and input decoders in addition to
  upstream VT coverage;
- deterministic engine traces for topology and ordered mixed keyboard/mouse/command input;
- AddressSanitizer and UndefinedBehaviorSanitizer runs plus the four supported host architectures;
- repeated attach/detach, resize, split/close, output-flood, slow-client, and extension-crash stress
  tests; and
- a multi-day soak with representative shells and applications before promoting a release.

Every externally triggered failure must either return a bounded error, disconnect the offending
peer, or perform a documented state transition. Internal invariant failure remains fail-fast rather
than continuing with corrupt state.

## Compatibility matrix

Release testing includes at least:

- interactive shells: zsh, bash, and fish;
- editors: Neovim and one common terminal editor using alternate screen and mouse input;
- pagers and monitors: less, man, top/htop-class tools;
- REPLs and TUIs with bracketed paste, focus, and extended keys;
- the native presentation backend plus the ANSI compatibility backend in Ghostty and representative
  outer terminals on each supported OS; and
- local Unix sockets and the same checkpoint/event scenarios over SSH stdio.

The matrix records known limitations by Fiber version. Passing one high-throughput benchmark does not
substitute for interaction correctness.

## Daily-driver exit gate

Fiber can claim day-to-day readiness only when:

1. the required local behavior above is implemented or an omission is deliberately removed from the
   release contract;
2. keyboard and mouse paths pass their shared semantic, forwarding, and applicable presentation
   restoration tests;
3. checkpoint/event equivalence, bounded lag recovery, and Unix/SSH transport suites pass;
4. performance suites show no unexplained regressions against reviewed budgets;
5. sanitizer, platform, stress, and soak suites pass;
6. installation and upgrade paths are tested from release artifacts; and
7. a focused external cohort uses Fiber as its primary multiplexer for at least 30 days, with reasons
   for returning to another tool tracked and triaged.
