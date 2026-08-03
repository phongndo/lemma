# Lemma daily-driver contract

## Purpose

Lemma 1.0 must be an excellent day-to-day server-rendered terminal multiplexer with a complete
semantic automation spine before it expands into shared sessions, native presentation, or provider-
specific agent products. This document defines the quality
gate. It is narrower than feature parity with tmux or Zellij and stronger than merely having a code
path for each feature.

Current implementation status is documented in
[`current-capabilities.md`](current-capabilities.md), architecture in
[`architecture.md`](architecture.md), and outcome/priority guidance in [`roadmap.md`](roadmap.md).

## Completion rule

A feature is complete only when all applicable parts exist:

1. documented user and failure behavior;
2. keyboard access and first-class mouse behavior where spatial interaction applies;
3. one typed semantic command/state path rather than duplicated mutations;
4. explicit ownership, capacity, queue, payload, allocation, and per-turn work bounds;
5. unit, integration, malformed-input, cleanup, capacity, and recovery tests;
6. a benchmark or trace when input, PTY, rendering, layout, or protocol hot paths change; and
7. user-facing help, diagnostics, and release notes.

Partial behavior remains labeled experimental or incomplete.

## Required local mux behavior

### Startup and lifecycle

- Plain `lemma` predictably creates or enters the `default` space.
- Named spaces can be created, listed, attached, detached, renamed, and killed.
- Client EOF, crash, terminal closure, or network loss does not end space processes.
- Child exit, shell launch failure, capacity exhaustion, stale sockets, and incompatible clients
  produce actionable errors and nonzero statuses where appropriate.
- Detach, logout, daemon failure, shutdown, and reboot guarantees are explicit and tested.
- Endpoint permissions and ownership prevent another local user from controlling a daemon.
- Space creation applies the documented cwd and bounded environment policy.

### Windows

- Create, close, rename, list, directly select, cycle, and reorder windows.
- Preserve stable identities, per-window layout, focus, zoom, ratios, and foreground-process title.
- Keep the active window visible in bounded status output at narrow widths.
- Provide keyboard and mouse selection through the same command dispatcher.

### Panes and layouts

- Split left/right and top/bottom, close, zoom, and focus by direction or order.
- Resize incrementally with the keyboard and by dragging separators with the mouse.
- Preserve valid minimum sizes and deterministic ratios across client resize.
- Resolve nested layouts without overlap, gaps, invalid focus, or unbounded traversal.
- Make pane targets visible through status, borders, or a bounded identification overlay.
- Handle child exit without corrupting the remaining split tree.

Preset layouts, pane swapping, and moving panes between spaces are desirable only after these
operations are dependable.

### Keyboard, mouse, paste, and focus

- Keyboard-only operation covers every core mux and copy workflow.
- Text, Unicode, control keys, Alt combinations, function/navigation keys, legacy mode, and supported
  extended-key input reach applications correctly.
- Prefix handling preserves order, has bounded incomplete-sequence behavior, and can send a literal
  prefix.
- Bracketed paste preserves boundaries, has explicit size/backpressure policy, and cannot become mux
  commands.
- Mouse click, release, motion/drag, and wheel decode into bounded typed values.
- The daemon hit-tests its status, separators, panes, overlays, and per-attachment selection state.
- Application mouse input is translated to a validated pane ID and pane-local cells, then encoded
  through canonical terminal modes.
- A configurable modifier overrides application capture for Lemma interaction.
- Focus is forwarded only when requested by the focused application.
- Client startup and every exit path restore raw mode, cursor, alternate screen, paste, focus,
  keyboard, mouse, and synchronized-update modes exactly.

### Copy, search, selection, and clipboard

- The daemon owns independent viewport, copy cursor, search, selection, follow-output, and unread
  state for each attachment; none mutates canonical terminal content.
- Copy mode does not stop PTY parsing or lose new output.
- Navigate retained scrollback by cell, line, page, word, and buffer boundary.
- Select by character, word, and line through keyboard and mouse paths sharing one model.
- Search forward/backward with bounded state and visible no-match behavior.
- Copy plain text predictably across wrapped lines, wide cells, grapheme clusters, and combining
  characters.
- Platform clipboard and OSC 52 behavior follow an explicit bounded security policy.
- Wheel behavior is defined separately for normal screen, alternate screen, copy mode, and
  applications requesting mouse tracking.

### Authoritative terminal and server rendering

- The daemon is the only VT parser and terminal authority; every pane owns one canonical Ghostty
  terminal and scrollback history.
- UTF-8, graphemes, combining marks, wide cells, true color, supported styles, cursor shapes, tab
  stops, wrapping, scroll regions, resize reflow, and alternate screen behave correctly.
- Terminal queries produce exactly one daemon-owned response stream ordered with accepted input.
- Synchronized updates, bracketed paste, focus, hyperlinks, title changes, bells, and supported modes
  do not leak pane state into Lemma chrome.
- Damage composition renders panes, separators, status, overlays, cursor, and outer modes without
  visible partial-topology transitions.
- Attach, active-window change, resize, lag recovery, and reconnect reconstruct complete visible
  state from canonical daemon state.
- Client frame queues and progress deadlines are bounded; a blocked client cannot stop PTYs or other
  work.
- `$TERM` and terminfo behavior is truthful, and unsupported graphics/protocols are documented.

### Configuration and automation

- Missing configuration selects useful defaults.
- Invalid configuration reports file/line context and preserves the previous valid generation.
- Prefixes, keyboard/mouse bindings, status behavior, shell, and default space behavior are
  configurable through typed validated values.
- Reload is transactional; blocked or crashed Lua cannot block input, PTYs, rendering, or process
  lifetime.
- `lemma --help` and generated command/binding/schema references make core operation discoverable.
- Explicit `--format=json` and the same-user semantic automation socket have documented compatibility,
  bounds, cancellation, and mismatch behavior independent from private attach framing.
- Every supported human mutation has an automation equivalent or documented exclusion.
- An agent can discover context, launch, inspect, capture, wait, cancel, and mutate topology without
  screen scraping; provider-specific state remains extension-owned.

### Installation and upgrades

- Users install checksummed macOS/Linux artifacts without compiling dependencies.
- Version output identifies Lemma, private protocol compatibility, build mode, and relevant dependency
  revisions.
- Client/daemon mismatches fail with an upgrade/restart instruction rather than wire corruption.
- Upgrade notes identify configuration, protocol, state, and behavior changes.
- Uninstall and daemon cleanup are documented and do not silently kill unexpected processes.

### Remote baseline

- `ssh -t HOST lemma` supports ordinary attach, input, detach, terminal resize, and client-loss
  process continuity on a configured remote host.
- Machine-readable CLI commands work through ordinary SSH without a hosted service.
- Remote behavior documents host-side configuration, cwd/environment, logout, and daemon-lifetime
  limitations.
- A custom SSH-stdio transport, configuration synchronization, multiplayer, and control transfer are
  not required for 1.0.

## Performance contract

Performance is measured end to end. The daily-driver suite covers distributions and resource use:

- key-to-PTY and key-to-visible latency at idle and under output load;
- click-to-focus, drag-to-layout, wheel-to-scroll, and application mouse pass-through;
- sparse editor updates, full-screen redraws, synchronized updates, and high scroll;
- one, four, sixteen, and maximum configured pane layouts;
- active/inactive windows, attach reconstruction, full-redraw recovery, resize storms, and status
  changes;
- slow/blocked clients, PTYs, and extension hosts;
- idle CPU/wakeups, daemon baseline memory, incremental memory per pane/attachment, and peak bounded
  queues; and
- daemon-to-client bytes alongside latency so coalescing does not hide bandwidth cost; and
- JSON/persistent-agent command, snapshot, launch, capture, wait, cancel, and event latency/bytes under
  concurrent PTY/render load.

The suite records p50/p95/p99 where sample count supports them. Stable benchmarks gain reviewed
regression budgets. Results remain labeled by hardware, OS, outer terminal, transport, presentation,
and workload. Ordinary SSH tests record the same core latency and byte measurements where practical.

Hot-path invariants from [`architecture.md`](architecture.md) and
[`performance.md`](performance.md) remain mandatory: no synchronous extension waits, no slow-client
PTY stalls, bounded per-turn terminal/input/render work, and no accidental steady-state general-heap
use.

## Robustness contract

The daily-driver gate requires:

- unit and property tests for IDs, split trees, hit testing, selection, decoders, commands, framing,
  and bounds;
- pseudoterminal integration tests for launch, input, paste, mouse modes, resize, detach/attach,
  child exit, full redraw, and terminal restoration;
- protocol fragmentation, coalescing, malformed, oversized, flood, deadline, and mismatch tests;
- deterministic engine traces for topology and mixed keyboard/mouse/command input;
- fuzz coverage for untrusted client, control, extension, and physical-input decoders;
- AddressSanitizer and UndefinedBehaviorSanitizer plus the supported host architectures;
- repeated attach/detach, resize, split/close, output flood, slow client, and extension crash stress;
- ordinary SSH attach/loss/resize scenarios, plus agent schema/run/capture/wait/cancel scenarios; and
- a multi-day soak with representative shells and applications before 1.0.

Every externally triggered failure returns a bounded error, disconnects the offending peer, or
performs a documented state transition. Internal invariant failure remains fail-fast.

## Compatibility matrix

Release testing includes at least:

- zsh, bash, and fish;
- Neovim and another common terminal editor using alternate screen and mouse input;
- less, man, and top/htop-class tools;
- REPLs and TUIs using bracketed paste, focus, and extended keys;
- the ANSI client in Ghostty and representative outer terminals on each supported OS; and
- local operation plus ordinary SSH operation.

The matrix records known limitations by Lemma version. One throughput benchmark does not substitute
for interaction correctness.

## Daily-driver exit gate

Lemma may claim 1.0 daily-driver readiness only when:

1. included local behavior above is implemented or deliberately removed from the release contract;
2. keyboard and mouse paths pass semantic, forwarding, and restoration tests;
3. attach, full-redraw recovery, blocked-client, local protocol, and SSH suites pass;
4. performance shows no unexplained regressions against reviewed budgets;
5. sanitizer, platform, stress, fuzz, and soak suites pass;
6. installation and upgrade paths pass from release artifacts;
7. an isolated agent completes semantic discovery and run/observe/control workflows without screen
   scraping or unbounded polling; and
8. a focused external cohort uses Lemma as its primary mux for at least 30 days, with abandonment
   reasons tracked and triaged.
