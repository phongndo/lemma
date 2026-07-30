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

- [x] Pass the current 60 component tests.
- [x] Cover four host architectures in scheduled CI.
- [x] Run Linux ASan/UBSan in scheduled CI.
- [x] Maintain terminal, renderer, command, and extension codec benchmarks.
- [x] Manually smoke create/attach/split/window/zoom/detach/list/kill through a pseudoterminal.

# Phase 1 — excellent local daily-driver mux

Immediate execution plan:
[`.plan/next-phase.md`](.plan/next-phase.md).

Later programmable and remote phases do not take priority until this phase satisfies the daily-driver
exit gate.

## P0 — protect the working vertical slice

### Checked-in process-level harness

Implementation plan: [`docs/plans/process-level-pty-harness.md`](docs/plans/process-level-pty-harness.md).

- [ ] Add a reusable pseudoterminal process harness under `tests/` or `tools/`.
- [ ] Give tests isolated daemon endpoints so they cannot affect a user's daemon or each other.
- [ ] Bound every harness wait and print useful process/output diagnostics on timeout.
- [ ] Test daemon launch and workspace creation from a clean environment.
- [ ] Test attach, ordinary key input, and visible shell output.
- [ ] Test horizontal and vertical splits.
- [ ] Test directional, next, and previous focus.
- [ ] Test pane close and zoom.
- [ ] Test window create, cycle, direct select, and close.
- [ ] Test outer resize and too-small-layout suspension/recovery.
- [ ] Test detach, process continuity, and reattach reconstruction.
- [ ] Test abrupt client EOF/crash without process loss.
- [ ] Test child exit, pane reclamation, and final-workspace cleanup.
- [ ] Test normal terminal restoration after detach and daemon disconnect.
- [ ] Move the warm-session multiplexer benchmark harness into the repository.

## P0 — make every accepted connection nonblocking

- [ ] Set the listener and every accepted descriptor nonblocking immediately.
- [ ] Introduce bounded generational connection slots owned by the reactor.
- [ ] Represent control/attach setup as an incremental state machine.
- [ ] Incrementally decode command, name, dimensions, and handshake data.
- [ ] Add bounded setup input and output buffers.
- [ ] Queue the initial full attach frame instead of sending it synchronously.
- [ ] Queue list/window/error responses instead of writing synchronously in the reactor.
- [ ] Add setup progress deadlines and deterministic timeout errors.
- [ ] Reject connection-capacity exhaustion without affecting existing sessions.
- [ ] Ensure one idle peer cannot delay PTY reads, client input, frames, or extensions.
- [ ] Test fragmented, coalesced, idle, disconnecting, malformed, and non-reading peers.
- [ ] Test slow control clients and slow initial-attach clients.

## P0 — add bounded PTY write backpressure

- [ ] Add one bounded ordered PTY write queue per pane.
- [ ] Queue user key/text/paste input instead of calling `write_all` on a nonblocking PTY.
- [ ] Queue terminal-generated responses on the same explicitly ordered path.
- [ ] Poll `POLLOUT` only while a pane has queued writes.
- [ ] Handle partial writes, `EINTR`, and `EAGAIN` without detaching or retiring the pane.
- [ ] Define queue capacity and separate per-turn write budgets.
- [ ] Define observable overflow behavior for user input, paste, and terminal responses.
- [ ] Preserve ordering between terminal responses and subsequent user input.
- [ ] Test blocked PTYs, partial writes, recovery, overflow, and fairness across panes.
- [ ] Benchmark input latency while another pane's PTY write side is blocked.

## P0 — resolve first-release product decisions

- [ ] Decide what plain `fiber` does.
- [ ] Decide default workspace creation/selection behavior.
- [ ] Define pane cwd inheritance for first pane, split pane, and new window.
- [ ] Define environment refresh/inheritance behavior.
- [ ] Decide whether v0.1 supports custom launch commands or login shells only.
- [ ] Define detach, client-crash, logout, daemon-crash, and reboot guarantees separately.
- [ ] Select initial supported macOS and Linux versions.
- [ ] Decide whether to keep the Fiber name before broad adoption.
- [ ] Define default prefix, copy-mode keys, mouse enablement, and mouse-capture override.
- [ ] Decide whether first automation is machine-readable CLI output, local RPC, or both.
- [ ] Record decisions in `docs/product-contract.md` before implementation depends on them.

## P1 — authoritative IDs and generalized local protocol

### Core identities

- [ ] Move workspaces into a generational store and assign `WorkspaceId`.
- [ ] Move panes into a generational store and assign `PaneId`.
- [ ] Assign `ClientId` to accepted/attached clients.
- [ ] Preserve existing generational `WindowId` behavior.
- [ ] Resolve every explicit command target at the core trust boundary.
- [ ] Reject stale workspace, window, pane, and client IDs.
- [ ] Keep dense iteration and bounded lookup behavior.
- [ ] Add create/remove/reuse/wraparound/stale-ID tests for every store.

### Protocol envelope

- [ ] Define magic, protocol version, capabilities, message kind, flags, length, and request ID.
- [ ] Define maximum frame, decoder, request, response, and batch sizes.
- [ ] Add typed success, no-effect, capacity, unavailable, invalid-target, and protocol errors.
- [ ] Add client/daemon version mismatch diagnostics.
- [ ] Negotiate keyboard, mouse, extended-key, focus, paste, and output capabilities.
- [ ] Preserve command and input ordering across fragmented/coalesced transport reads.
- [ ] Frame daemon-to-client terminal output instead of relying on an unframed byte stream.
- [ ] Add golden encodings and round-trip tests.
- [ ] Add malformed length/enum/ID/version/capability tests.
- [ ] Add a Fiber protocol fuzz target and seed corpus.
- [ ] Support a deliberate migration from the current `fiber-v8` endpoint.

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

### Core routing

- [ ] Add bounded hit testing for panes, separators, status, overlays, and selections.
- [ ] Translate outer mouse coordinates into pane-local cells.
- [ ] Route Fiber chrome before application mouse capture.
- [ ] Implement configurable override of application mouse capture.
- [ ] Encode application mouse events through the terminal adapter's canonical modes.
- [ ] Implement keyboard focus and click-to-focus through the same `focus` command.
- [ ] Implement keyboard window selection and status click selection through the same command.
- [ ] Test X10, normal, button, any-motion, SGR, alternate-scroll, and focus combinations that Fiber
      claims to support.
- [ ] Benchmark key-to-PTY, key-to-frame, click-to-focus, and mouse pass-through latency.

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

### Viewport and copy mode

- [ ] Add per-client viewport state separate from canonical pane terminal state.
- [ ] Enter/leave copy mode without stopping PTY parsing or losing new scrollback.
- [ ] Navigate by cell, line, page, word, top, and bottom with the keyboard.
- [ ] Define follow-output and unread-output behavior while scrolled back.
- [ ] Add bounded pane scrollback traversal APIs to the terminal adapter.
- [ ] Reconstruct copy-mode viewport after resize and new output.

### Search

- [ ] Add bounded incremental forward/backward search.
- [ ] Define case sensitivity, wrapping, cancellation, and no-match behavior.
- [ ] Highlight current/all matches without corrupting terminal damage state.
- [ ] Test search across wrapped rows, scrollback boundaries, Unicode, and new output.

### Selection and clipboard

- [ ] Add one canonical character/word/line selection model.
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

## P2 — terminal compatibility and rendering completion

- [ ] Define and ship truthful `$TERM`/terminfo behavior.
- [ ] Define supported legacy and extended keyboard protocols.
- [ ] Verify UTF-8, graphemes, combining marks, wide cells, wrapping, tab stops, and resize reflow.
- [ ] Verify true color, supported styles, cursor shapes, scroll regions, and alternate screen.
- [ ] Verify synchronized updates, bracketed paste, focus events, hyperlinks, titles, and queries.
- [ ] Define bells, activity, and notification behavior.
- [ ] Ensure pane modes never leak into status, separators, overlays, or copy mode.
- [ ] Document unsupported graphics/image protocols explicitly.
- [ ] Test Ghostty and representative outer terminals on each supported OS.
- [ ] Test zsh, bash, fish, Neovim, terminal editors, less/man, htop-class tools, REPLs, and TUIs.

## P2 — performance and robustness gate

### End-to-end performance

- [ ] Add repeatable key-to-PTY and key-to-visible-frame latency harnesses.
- [ ] Measure p50/p95/p99 at idle and during output load.
- [ ] Measure sparse editor, full redraw, synchronized update, and high-scroll workloads.
- [ ] Measure one/four/sixteen/maximum panes and active/inactive windows.
- [ ] Measure attach reconstruction, status changes, and resize storms.
- [ ] Measure slow/blocked clients and slow/blocked extension hosts.
- [ ] Measure idle CPU/wakeups and daemon baseline memory.
- [ ] Measure incremental/peak memory per pane, window, workspace, and client.
- [ ] Record bytes written alongside frame latency.
- [ ] Set reviewed regression budgets once each harness is stable.
- [ ] Run release benchmark smoke in CI and fuller comparisons on a controlled machine.

### Correctness and stress

- [ ] Add property/model tests for generational stores and split trees.
- [ ] Add deterministic traces for topology plus mixed keyboard/mouse/command input.
- [ ] Fuzz untrusted control, attached-client, extension, and input decoders.
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
- [ ] No supported exit path leaves outer terminal state corrupted.
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
- [ ] Render validated retained status/sidebar surfaces without synchronous Lua calls.
- [ ] Expose machine-readable local automation results.
- [ ] Publish maintained example extensions.
- [ ] Document extension API lifecycle and compatibility policy.
- [ ] Verify blocked, malformed, or crashed extensions cannot affect mux progress or pane processes.

# Phase 3 — remote, shared, and agent-driven Fiber

- [ ] Add SSH-stdio transport using the same versioned semantic protocol.
- [ ] Define remote daemon bootstrap, cwd/environment, configuration, and upgrade behavior.
- [ ] Add per-client physical/render/viewport state.
- [ ] Support multiple attached clients.
- [ ] Add explicit viewer/controller permissions and control transfer.
- [ ] Preserve keyboard, mouse, paste, focus, resize, and command ordering remotely.
- [ ] Expose commands, snapshots, events, output, cancellation, and capacity to coding agents.
- [ ] Add peer authentication and hostile-client tests.
- [ ] Document the local/remote security model.
- [ ] Verify disconnect/reconnect and shared access without process loss from client failure.

# v1.0 — trusted infrastructure

- [ ] Publish stable configuration and upgrade policies.
- [ ] Publish protocol compatibility and deprecation policy.
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
