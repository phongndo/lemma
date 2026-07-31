# Fiber TODO

This is the operational checklist for turning Fiber's working vertical slice into a robust,
performant daily-driver multiplexer and then extending it to programmable, remote, shared, and
agent-driven sessions.

Supporting contracts:

- [`docs/current-capabilities.md`](docs/current-capabilities.md) — audited present state;
- [`docs/daily-driver-contract.md`](docs/daily-driver-contract.md) — local mux quality gate;
- [`docs/roadmap.md`](docs/roadmap.md) — milestone order and release gates;
- [`docs/product-contract.md`](docs/product-contract.md) — committed product decisions;
- [`docs/architecture.md`](docs/architecture.md) — ownership and performance invariants.

A checked baseline item means the behavior exists at the current audit; it does not waive the
completion requirements below.

## Phase plan archive convention

Milestone execution plans live under `.plan/` and use durable numbered filenames:
`NNN-kebab-case-phase-name.md` (for example, `001-p0-local-mux-hardening.md`). Allocate the next
zero-padded three-digit number when a phase is created, keep that filename while its status moves
from proposed to active to complete, and never reuse a number or rename a completed phase to
`next-phase.md`.

On completion, turn the plan into an archive in place by recording delivery dates, evidence,
deviations, remaining hosted validation, and links back to this checklist and the roadmap. The TODO
and roadmap identify the active phase; no mutable `next-phase.md` alias is maintained. Detailed
subsystem designs may remain under `docs/plans/`, while milestone execution records follow this
numbered `.plan/` convention.

## Definition of done for every feature

A feature is complete only when all applicable boxes are satisfied:

- [ ] User behavior and failure behavior are documented.
- [ ] Keyboard access is complete and mouse behavior is first-class where spatial interaction
      applies.
- [ ] Equivalent inputs converge on one typed semantic command/state path.
- [ ] Ownership, capacity, queue, payload, and per-turn work bounds are explicit.
- [ ] Normal, capacity, malformed-input, cleanup, and recovery tests exist.
- [ ] Hot-path work has an end-to-end benchmark or trace with a reviewed regression budget.
- [ ] User-facing help, diagnostics, and release notes are updated.

## Existing baseline

### Project

- [x] Publish Fiber under the MIT license.
- [x] Define the “terminal multiplexer built like infrastructure” identity.
- [x] Document the target architecture and product contract.
- [x] Audit current capabilities and limitations.
- [x] Define the daily-driver quality contract.
- [x] Define milestone and release gates.

### Runtime

- [x] Run one per-user daemon with a locked `0600` Unix socket.
- [x] Detect and remove safe stale sockets.
- [x] Support named workspaces and detached process continuity.
- [x] Support multiple windows per workspace.
- [x] Support nested left/right and top/bottom pane splits.
- [x] Support directional, next, and previous pane focus.
- [x] Support pane close and zoom.
- [x] Support window create, cycle, direct select, and close.
- [x] Resize active pane PTYs after outer-terminal resize.
- [x] Continue processing PTYs in detached workspaces and inactive windows.
- [x] Reclaim exited panes and empty windows/workspaces.

### Terminal and rendering

- [x] Isolate `libghostty-vt` behind a Fiber-owned adapter.
- [x] Give every pane canonical terminal and scrollback state.
- [x] Capture terminal responses, titles, bells, modes, and dirty state.
- [x] Render dirty rows/cell spans and detected scroll operations.
- [x] Compose panes, separators, status, cursor, and modes into synchronized frames.
- [x] Reconstruct visible state after attach, window change, and resize.
- [x] Keep one bounded client frame in flight without synchronously stopping PTY reads.

### Commands, input, and extensions

- [x] Route existing pane/window mutations through a typed command dispatcher.
- [x] Provide fixed tmux-compatible `C-b` keyboard commands.
- [x] Preserve ordinary input order around prefix commands.
- [x] Normalize common legacy keys through Ghostty's key encoder.
- [x] Run Lua 5.5 in an isolated daemon-managed process.
- [x] Register bounded transactional command, keymap, event, and sidebar generations.
- [x] Keep extension registration work after PTY, client-input, and rendering work.

### Current validation

- [x] Pass the current 72 component tests.
- [x] Cover four host architectures in scheduled CI.
- [x] Run Linux ASan/UBSan in scheduled CI.
- [x] Maintain terminal, renderer, command, and extension codec benchmarks.
- [x] Manually smoke create/attach/split/window/zoom/detach/list/kill through a pseudoterminal.

# Phase 1 — excellent local daily-driver mux

Archived P0 execution record:
[`.plan/001-p0-local-mux-hardening.md`](.plan/001-p0-local-mux-hardening.md). The active sequence after
P0 is maintained in [`docs/roadmap.md`](docs/roadmap.md).

Later programmable, shared, agent, and broad remote-product phases do not take priority until this
phase satisfies the daily-driver exit gate. The replication protocol is nevertheless validated over
SSH during P1 so local-only transport assumptions cannot harden into the architecture.

## P0 — protect the working vertical slice

### Checked-in process-level harness

Implementation plan: [`docs/plans/process-level-pty-harness.md`](docs/plans/process-level-pty-harness.md).

- [x] Add a reusable pseudoterminal process harness under `tests/` or `tools/`.
- [x] Give tests isolated daemon endpoints so they cannot affect a user's daemon or each other.
- [x] Bound every harness wait and print useful process/output diagnostics on timeout.
- [x] Test daemon launch and workspace creation from a clean environment.
- [x] Test attach, ordinary key input, and visible shell output.
- [x] Test horizontal and vertical splits.
- [x] Test directional, next, and previous focus.
- [x] Test pane close and zoom.
- [x] Test window create, cycle, direct select, and close.
- [x] Test outer resize and too-small-layout suspension/recovery.
- [x] Test detach, process continuity, and reattach reconstruction.
- [x] Test abrupt client EOF/crash without process loss.
- [x] Test child exit, pane reclamation, and final-workspace cleanup.
- [x] Test normal terminal restoration after detach and daemon disconnect.
- [x] Move the warm-session multiplexer benchmark harness into the repository.

## P0 — make every accepted connection nonblocking

- [x] Set the listener and every accepted descriptor nonblocking immediately.
- [x] Introduce bounded generational connection slots owned by the reactor.
- [x] Represent control/attach setup as an incremental state machine.
- [x] Incrementally decode command, name, dimensions, and handshake data.
- [x] Add bounded setup input and output buffers.
- [x] Queue the initial full attach frame instead of sending it synchronously.
- [x] Queue list/window/error responses instead of writing synchronously in the reactor.
- [x] Add bounded setup progress deadlines; add explicit timeout diagnostics with the versioned protocol.
- [x] Reject connection-capacity exhaustion without affecting existing sessions.
- [x] Ensure one idle peer cannot delay PTY reads, client input, frames, or extensions.
- [x] Test fragmented, coalesced, idle, disconnecting, malformed, and non-reading peers.
- [x] Test slow control clients and slow initial-attach clients.

## P0 — add bounded PTY write backpressure

- [x] Add one bounded ordered PTY write queue per pane.
- [x] Queue user key/text/paste input instead of calling `write_all` on a nonblocking PTY.
- [x] Queue terminal-generated responses on the same explicitly ordered path.
- [x] Poll `POLLOUT` only while a pane has queued writes.
- [x] Handle partial writes, `EINTR`, and `EAGAIN` without detaching or retiring the pane.
- [x] Define queue capacity and separate per-turn write budgets.
- [x] Backpressure user input before acceptance and retire a pane on a true terminal-response capacity failure.
- [x] Preserve ordering between terminal responses and subsequent user input.
- [x] Test blocked PTYs, partial writes, recovery, overflow, and fairness across panes.
- [x] Benchmark input latency while another pane's PTY write side is blocked.

## P0 — resolve first-release product decisions

- [x] Decide what plain `fiber` does.
- [x] Decide default workspace creation/selection behavior.
- [x] Define pane cwd inheritance for first pane, split pane, and new window.
- [x] Define environment refresh/inheritance behavior.
- [x] Decide whether v0.1 supports custom launch commands or login shells only.
- [x] Define detach, client-crash, logout, daemon-crash, and reboot guarantees separately.
- [x] Select initial supported macOS and Linux versions.
- [x] Decide whether to keep the Fiber name before broad adoption.
- [x] Define default prefix, copy-mode keys, mouse enablement, and mouse-capture override.
- [x] Decide whether first automation is machine-readable CLI output, local RPC, or both.
- [x] Record decisions in `docs/product-contract.md` before implementation depends on them.

## P1 — terminal checkpoint and replicated-client foundation

Active feasibility plan:
[`.plan/002-terminal-checkpoint-feasibility.md`](.plan/002-terminal-checkpoint-feasibility.md).
Contingent implementation plan:
[`.plan/003-replicated-terminal-foundation.md`](.plan/003-replicated-terminal-foundation.md).

### Mandatory terminal-checkpoint feasibility gate

- [ ] Inventory every canonical terminal/parser/mode/effect/history value required for deterministic
      continuation at an arbitrary PTY read boundary.
- [ ] Define authoritative-daemon and replica-client terminal roles, including suppression of replica
      PTY responses and policy side effects.
- [ ] Design a bounded versioned Fiber-owned checkpoint value that exposes no Ghostty private memory
      layout.
- [ ] Prototype transactional checkpoint export/import behind `fiber_terminal`.
- [ ] Prove checkpoint at sequence `N` plus the event tail equals uninterrupted parsing across text,
      alternate-screen, resize/reflow, incomplete escape/UTF-8, query, and scrollback traces.
- [ ] Prove visible-ready state can precede bounded recent-to-oldest history hydration.
- [ ] Measure checkpoint bytes, export/import time, peak memory, and history chunk behavior.
- [ ] Record required upstream `libghostty-vt` API work and archive an explicit Pass or Stop decision.

### Core identities

- [ ] Move workspaces into a generational store and assign `WorkspaceId`.
- [ ] Move panes into a generational store and assign `PaneId`.
- [ ] Assign `ClientId` to accepted/attached clients.
- [ ] Preserve existing generational `WindowId` behavior.
- [ ] Resolve every explicit command target at the core trust boundary.
- [ ] Reject stale workspace, window, pane, and client IDs.
- [ ] Keep dense iteration and bounded lookup behavior.
- [ ] Add create/remove/reuse/wraparound/stale-ID tests for every store.

### Versioned bidirectional protocol

- [ ] Define magic, protocol/checkpoint versions, capabilities, message kind, flags, length, and
      request/result correlation.
- [ ] Define maximum frame, decoder, request, response, checkpoint, event-tail, history, and batch
      sizes plus aggregate per-client limits.
- [ ] Add typed success, no-effect, capacity, unavailable, invalid-target, unauthorized, mismatch,
      and protocol errors.
- [ ] Add client/daemon/protocol/checkpoint version mismatch diagnostics.
- [ ] Negotiate keyboard, mouse, extended-key, focus, paste, history, compression, presentation, and
      transport capabilities.
- [ ] Preserve command, input, and per-pane terminal-event ordering across fragmented/coalesced reads.
- [ ] Give every pane one sequence covering output, resize, reset, and exit events.
- [ ] Define topology snapshot/delta, terminal checkpoint, ready, output, history, acknowledgement,
      resume, reset, and resynchronization messages.
- [ ] Frame both directions; do not wrap daemon-rendered ANSI as the generalized output model.
- [ ] Add golden encodings, round trips, malformed matrices, and checkpoint-tail equivalence tests.
- [ ] Add Fiber protocol and checkpoint-import fuzz targets with bounded seed corpora.
- [ ] Support a deliberate temporary migration endpoint distinct from `fiber-v8`.

### Smart client and production cutover

- [ ] Give the client bounded terminal replica stores and synchronization state.
- [ ] Import checkpoints transactionally and apply ordered pane event tails without generating PTY
      responses.
- [ ] Add contiguous acknowledgements, bounded resumable tails, forced fresh-checkpoint recovery, and
      disconnect when even bounded checkpoint progress fails.
- [ ] Replicate logical topology with stable IDs and move physical rectangles/view state into the
      client.
- [ ] Move the existing ANSI compositor behind the smart compatibility client.
- [ ] Pass the existing split/focus/zoom/window/resize/detach process suite through client-side
      replicas and composition.
- [ ] Remove production daemon-to-attached-client unframed/composed ANSI and retire `fiber-v8` after
      explicit cutover tests.

### Early remote transport proof

- [ ] Carry the identical application protocol over Unix sockets and SSH stdio.
- [ ] Test attach, progressive history, disconnect, resume, forced checkpoint, mismatch, and process
      continuity over both transports.
- [ ] Shape latency, bandwidth, short writes, and output floods while bounding lag and preserving
      input responsiveness.
- [ ] Measure optional compression for large checkpoint/history/output chunks without assuming small
      interactive frames benefit.

## P1 — first-class keyboard and mouse input

### Typed input

- [ ] Define bounded typed key values including action, modifiers, codepoint, and text.
- [ ] Define bounded text and paste values with explicit paste boundaries.
- [ ] Define focus-in/focus-out values.
- [ ] Define resize values including cell and available pixel dimensions.
- [ ] Define mouse action, button, modifiers, cell coordinates, and bounded wheel deltas.
- [ ] Preserve mixed key/text/paste/focus/mouse/command ordering.
- [ ] Bound or coalesce mouse motion and wheel floods without reordering clicks or keys.

### Client decoding and lifecycle

- [ ] Decode legacy keys without breaking unknown escape sequences.
- [ ] Negotiate and decode supported extended keyboard protocols.
- [ ] Keep a literal-prefix path and bounded incomplete-sequence behavior.
- [ ] Detect bracketed paste so payload bytes cannot become mux commands.
- [ ] Enable only negotiated outer-terminal focus/mouse/keyboard modes.
- [ ] Restore termios, cursor, alternate screen, synchronized updates, paste, focus, keyboard, and
      mouse modes on normal exit.
- [ ] Add signal-safe cleanup/restoration strategy for termination paths.
- [ ] Test partial startup failure and daemon disconnect during every client lifecycle stage.

### Client hit testing and authoritative routing

- [ ] Add bounded client-side hit testing for pane presentation, separators, status, overlays, and
      selections.
- [ ] Translate client presentation coordinates into stable semantic targets; physical rectangles
      never become core identities.
- [ ] Send application mouse input with `PaneId` and pane-local cells.
- [ ] Route Fiber chrome before application mouse capture.
- [ ] Implement configurable override of application mouse capture.
- [ ] Validate pane/permission/coordinate targets and encode application mouse events through the
      authoritative terminal adapter's modes.
- [ ] Implement keyboard focus and click-to-focus through the same `focus` command.
- [ ] Implement keyboard window selection and status click selection through the same command.
- [ ] Test X10, normal, button, any-motion, SGR, alternate-scroll, and focus combinations that Fiber
      claims to support.
- [ ] Benchmark key-to-PTY, key-to-visible-presentation, click-to-focus, and mouse pass-through
      latency locally and over shaped SSH.

## P1 — local startup, errors, and process behavior

- [ ] Implement the decided plain-`fiber` behavior.
- [ ] Add explicit `--help` and `--version` output.
- [ ] Return nonzero status for invalid commands and failed attached-client loops.
- [ ] Report workspace/window/pane capacity and no-effect outcomes visibly.
- [ ] Report child launch and exit reasons.
- [ ] Apply the decided cwd/environment policy to first panes, splits, and new windows.
- [ ] Add optional explicit shell/command launch if included in the first-release contract.
- [ ] Add an explicit daemon shutdown command and safe no-workspace idle policy.
- [ ] Document endpoint, daemon, and process cleanup behavior.

## P1 — windows, panes, layouts, and status

### Windows

- [ ] Add user-defined window names.
- [ ] Add keyboard rename prompt/command.
- [ ] Add mouse-accessible rename through the same command where appropriate.
- [ ] Add stable window reorder operations.
- [ ] Keep active/previous selection correct after create, close, and reorder.
- [ ] Distinguish user name, foreground process, and terminal title in status policy.
- [ ] Add status hit testing and active-window overflow behavior tests.

### Panes and layouts

- [ ] Store adjustable split ratios in layout nodes.
- [ ] Add keyboard pane-resize commands.
- [ ] Add mouse separator drag using the same ratio mutation.
- [ ] Define minimum pane dimensions and clamping behavior.
- [ ] Preserve ratios deterministically across outer resizes.
- [ ] Add a bounded pane-identification overlay.
- [ ] Add public pane IDs and optional user-visible pane names.
- [ ] Test nested resize, tiny viewports, zoom, close, child exit, and ratio preservation.
- [ ] Benchmark layout resolution and resize storms at 1, 4, 16, and 64 panes.

## P2 — copy mode, search, selection, and clipboard

### Client-local viewport and copy mode

- [ ] Add viewport, copy cursor, follow-output, and unread-output state to each client terminal replica,
      separate from canonical daemon state.
- [ ] Enter/leave copy mode without stopping PTY parsing, live event application, or progressive
      history hydration.
- [ ] Navigate available history by cell, line, page, word, top, and bottom with the keyboard.
- [ ] Define loading and boundary behavior when requested older history is not present yet.
- [ ] Add bounded recent-to-oldest history range APIs and protocol requests.
- [ ] Reconstruct copy-mode viewport after checkpoint reset, resize, new output, and newly hydrated
      history.

### Search

- [ ] Add bounded incremental forward/backward search.
- [ ] Define case sensitivity, wrapping, cancellation, and no-match behavior.
- [ ] Highlight current/all matches without corrupting terminal damage state.
- [ ] Test search across wrapped rows, scrollback boundaries, Unicode, and new output.

### Selection and clipboard

- [ ] Add one client-local character/word/line selection model shared by keyboard and mouse input.
- [ ] Add keyboard selection operations.
- [ ] Add mouse click/drag and multi-click selection.
- [ ] Handle grapheme clusters, combining marks, wide cells, wrapped lines, and trailing spaces.
- [ ] Define linear versus rectangular selection scope.
- [ ] Copy through platform clipboard integration.
- [ ] Define bounded configurable OSC 52 policy and security behavior.
- [ ] Define wheel behavior for normal screen, alternate screen, copy mode, and app mouse capture.
- [ ] Test selection/copy across pane resize and continuing output.
- [ ] Benchmark wheel scrolling, selection updates, search, and large scrollback.

## P2 — configuration usable in daily operation

- [ ] Make `fiber.setup` validate and apply actual settings transactionally.
- [ ] Install declarative keyboard keymaps into C++ state.
- [ ] Install declarative mouse bindings into the same semantic command system.
- [ ] Invoke Lua command callbacks asynchronously.
- [ ] Keep built-in fallback bindings when config is missing or invalid.
- [ ] Add file/line context to configuration errors.
- [ ] Implement replacement-host reload that preserves the previous valid generation.
- [ ] Generate discoverable active command and binding references.
- [ ] Test blocked/crashed host behavior during input, output, reload, and daemon shutdown.
- [ ] Benchmark idle host overhead and keymap/command dispatch latency.

## P2 — native presentation, terminal compatibility, and rendering completion

- [ ] Deliver the primary native renderer over the same smart-client replica model.
- [ ] Define and ship truthful `$TERM`/terminfo behavior.
- [ ] Define supported legacy and extended keyboard protocols.
- [ ] Verify authoritative/replica equivalence for UTF-8, graphemes, combining marks, wide cells,
      wrapping, tab stops, resize reflow, and arbitrary parser chunk boundaries.
- [ ] Verify true color, supported styles, cursor shapes, scroll regions, alternate screen,
      synchronized updates, bracketed paste, focus, hyperlinks, titles, and queries.
- [ ] Define daemon-authoritative versus client-local bells, activity, clipboard, notification, and
      other side-effect behavior.
- [ ] Ensure pane modes never leak into status, separators, overlays, or copy mode.
- [ ] Document unsupported graphics/image/checkpoint features explicitly.
- [ ] Test the native backend and the ANSI compatibility backend in Ghostty and representative outer
      terminals on each supported OS.
- [ ] Test zsh, bash, fish, Neovim, terminal editors, less/man, htop-class tools, REPLs, and TUIs
      locally and through SSH.

## P2 — performance and robustness gate

### End-to-end performance

- [ ] Add repeatable key-to-PTY and key-to-visible-presentation latency harnesses.
- [ ] Measure p50/p95/p99 at idle and during output load.
- [ ] Measure sparse editor, full redraw, synchronized update, and high-scroll workloads.
- [ ] Measure one/four/sixteen/maximum panes and active/inactive windows.
- [ ] Measure checkpoint export/import, attach-to-ready, recent/full history hydration, status
      changes, and resize storms.
- [ ] Measure PTY-read-to-event, event-to-visible, acknowledgement lag, forced resynchronization, and
      reconnect latency.
- [ ] Measure slow/blocked clients and slow/blocked extension hosts over local Unix and shaped SSH.
- [ ] Measure idle CPU/wakeups and daemon baseline memory.
- [ ] Measure incremental/peak memory per pane, window, workspace, and client.
- [ ] Record checkpoint, event, history, and presentation bytes alongside latency.
- [ ] Set reviewed regression budgets once each harness is stable.
- [ ] Run release benchmark smoke in CI and fuller comparisons on a controlled machine.

### Correctness and stress

- [ ] Add property/model tests for generational stores and split trees.
- [ ] Add deterministic traces for topology plus mixed keyboard/mouse/command input.
- [ ] Fuzz untrusted control, attached-client, checkpoint-import, extension, and input decoders.
- [ ] Stress repeated attach/detach and client crashes.
- [ ] Stress split/resize/focus/close/window operations.
- [ ] Stress output floods, blocked PTYs, blocked clients, and extension crashes.
- [ ] Stress mouse motion/wheel floods and resize storms.
- [ ] Test every capacity boundary and one-past-capacity failure.
- [ ] Run ASan/UBSan for process-level tests.
- [ ] Add a multi-day soak using representative shells and applications.
- [ ] Track and eliminate unexplained terminal corruption, lost input, and process loss.

## v0.1 alpha distribution and feedback

- [ ] Add release version metadata and changelog policy.
- [ ] Produce checksummed macOS arm64/x86_64 archives.
- [ ] Produce checksummed Linux arm64/x86_64 archives.
- [ ] Test release artifacts outside the development shell.
- [ ] Write a five-minute install and first-session guide.
- [ ] Add shell completions.
- [ ] Record a short daily-workflow demonstration.
- [ ] Add Homebrew packaging after artifact URLs stabilize.
- [ ] Add `CONTRIBUTING.md` and bounded starter issues.
- [ ] Recruit an initial cohort of approximately ten external users.
- [ ] Record every reason users return to tmux/Zellij/another terminal workflow.

## Daily-driver release gate

- [ ] Every included local feature satisfies the definition of done.
- [ ] Keyboard-only operation covers every core workflow.
- [ ] Mouse focus, resize, status, selection, scrolling, and application forwarding are tested.
- [ ] No supported compatibility-client exit path leaves outer terminal state corrupted.
- [ ] Protocol fuzz, sanitizer, platform, stress, and soak suites pass.
- [ ] Performance has no unexplained regression outside reviewed budgets.
- [ ] Installation and upgrade paths pass from release artifacts.
- [ ] A focused external cohort uses Fiber as its primary multiplexer for at least 30 days.
- [ ] Reasons for abandoning Fiber are tracked, triaged, and reflected in the release decision.

# Phase 2 — programmable Fiber

Begin only after the daily-driver path is credible.

- [ ] Deliver immutable workspace/window/pane/client snapshots with stable IDs.
- [ ] Deliver bounded topology, focus, process, lifecycle, and configuration events.
- [ ] Make event loss observable and repairable from snapshots.
- [ ] Add asynchronous typed core-command requests/results for Lua.
- [ ] Add timers and asynchronous process APIs.
- [ ] Add bounded pane-output subscriptions with explicit backpressure/loss policy.
- [ ] Distribute validated retained status/sidebar models for client rendering without synchronous
      Lua calls.
- [ ] Expose machine-readable local automation results.
- [ ] Publish maintained example extensions.
- [ ] Document extension API lifecycle and compatibility policy.
- [ ] Verify blocked, malformed, or crashed extensions cannot affect mux progress or pane processes.

# Phase 3 — shared and agent-driven Fiber

Basic SSH-stdio transport, checkpoint attachment, and reconnect correctness are P1 architecture
requirements. This phase adds product breadth on that same protocol.

- [ ] Define remote daemon bootstrap, cwd/environment, configuration synchronization, and upgrade
      behavior.
- [ ] Support multiple attached clients with independent replica/view state.
- [ ] Add explicit viewer/controller permissions and control transfer.
- [ ] Preserve keyboard, mouse, paste, focus, resize, and command ordering remotely.
- [ ] Expose commands, snapshots, events, output, cancellation, and capacity to coding agents.
- [ ] Add peer authentication and hostile-client tests.
- [ ] Document the local/remote security model.
- [ ] Verify shared access, control transfer, and repeated resynchronization without process loss or
      canonical-state corruption from client failure.

# v1.0 — trusted infrastructure

- [ ] Publish stable configuration and upgrade policies.
- [ ] Publish protocol/checkpoint compatibility and deprecation policy.
- [ ] Publish security and supported-platform policy.
- [ ] Publish explicit detach, logout, daemon-crash, and reboot guarantees.
- [ ] Maintain supported macOS/Linux packages.
- [ ] Complete user, automation, extension, and troubleshooting documentation.
- [ ] Publish reproducible labeled performance/resource results.
- [ ] Demonstrate sustained daily use and a healthy contributor community.
- [ ] Release 1.0 only when the guarantees are credible, not when every competing command exists.

# Explicitly deferred

These are intentionally not current TODOs:

- Web and mobile clients.
- User accounts or a hosted control plane.
- Extension package discovery/marketplace.
- Generalized task/run/view entities.
- Production orchestration.
- Feature-for-feature competition with every multiplexer.
