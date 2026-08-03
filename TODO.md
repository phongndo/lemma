# Lemma TODO

This is the mutable execution backlog for turning Lemma's working server-rendered vertical slice
into a robust, programmable, agent-friendly daily driver and a credible 1.0 product. Ordering changes
when implementation evidence, user feedback, risk, or dependency discovery changes.

Supporting contracts:

- [`docs/current-capabilities.md`](docs/current-capabilities.md) — audited present state;
- [`docs/daily-driver-contract.md`](docs/daily-driver-contract.md) — daily-driver quality gate;
- [`docs/roadmap.md`](docs/roadmap.md) — outcome areas, priority constraints, and release gates;
- [`docs/product-contract.md`](docs/product-contract.md) — committed product decisions; and
- [`docs/architecture.md`](docs/architecture.md) — ownership and performance invariants.

A checked baseline item means behavior exists at the current audit; it does not waive the completion
requirements below.

## Working method

`TODO.md` is the source of current execution priority. Its sections are capability groups, not a
promise to finish one entire phase before learning from another. Keep a short current-focus list,
choose the smallest end-to-end slice that reduces the most risk, and reorder unchecked items whenever
evidence changes the best path. Checked items retain delivered evidence; unchecked items may be
split, merged, rewritten, moved, or deliberately dropped with the affected contract updated.

There is no separate plan directory or numbered plan sequence. Product work proceeds directly from
this backlog, the outcome/release guidance in `docs/roadmap.md`, tests, and the stable architecture/
product contracts. Durable technical evidence belongs in focused documentation, not execution plans.

## Definition of done

A feature is complete only when all applicable boxes are satisfied:

- [ ] User and failure behavior are documented.
- [ ] Keyboard access and first-class mouse behavior exist where spatial interaction applies.
- [ ] Equivalent inputs converge on one typed semantic command/state path.
- [ ] Ownership, capacity, queue, payload, allocation, and per-turn work bounds are explicit.
- [ ] Normal, capacity, malformed-input, cleanup, and recovery tests exist.
- [ ] Hot-path work has an end-to-end benchmark or trace with a reviewed regression budget.
- [ ] User-facing help, diagnostics, and release notes are updated.

## Current focus — revise whenever evidence changes

- [ ] Move spaces and panes into dense generational stores and make every explicit target stable.
- [ ] Add client/actor origin, request correlation, and typed command/result/error values shared by
      keyboard, mouse, Lua, JSON automation, and AI agents.
- [ ] Define the smallest public semantic automation slice: schema/context, launch, capture, wait,
      cancel, snapshots, and bounded event/output observation.
- [ ] Define a tmux-workflow parity matrix separating 1.0 essentials, extension-provided policy, and
      deliberately deferred commands.
- [ ] Prove one narrow vertical slice through C++ command, JSON CLI, persistent agent request, and Lua
      binding before expanding the API surface.
- [ ] Version and frame the private attached-client protocol without coupling it to the public
      semantic automation API.

This list is intentionally short. Completing, invalidating, or learning from one item may reorder the
others; update it in the same change.

## Existing baseline

### Product and architecture

- [x] Publish Lemma under the MIT license.
- [x] Define the “terminal multiplexer built like infrastructure” identity.
- [x] Complete P0 local mux hardening.
- [x] Run and archive the terminal-checkpoint feasibility gate with a Stop result.
- [x] Select authoritative server rendering as the production direction through 1.0.
- [x] Define the daily-driver and 1.0 quality gates.

### Runtime

- [x] Run one per-user daemon with a locked `0600` Unix socket.
- [x] Detect and remove safe stale sockets.
- [x] Support named spaces and detached process continuity.
- [x] Support multiple windows and nested left/right/top/bottom pane splits.
- [x] Support directional/next/previous focus, close, zoom, window create/cycle/select/close.
- [x] Resize active pane PTYs after outer-terminal resize.
- [x] Continue processing PTYs in detached spaces and inactive windows.
- [x] Reclaim exited panes and empty windows/spaces.
- [x] Keep accepted/setup/control connections bounded and nonblocking.
- [x] Keep ordered bounded PTY write queues with partial-write recovery and fairness.

### Terminal and rendering

- [x] Isolate `libghostty-vt` behind a Lemma-owned adapter.
- [x] Give every pane canonical daemon-owned terminal and scrollback state.
- [x] Capture terminal responses, titles, bells, modes, cursor, and dirty state.
- [x] Render dirty rows/cell spans and detected scroll operations.
- [x] Compose panes, separators, status, cursor, and modes into synchronized ANSI frames.
- [x] Reconstruct visible state after attach, active-window change, and resize.
- [x] Keep one bounded client frame in flight without synchronously stopping PTY reads.
- [x] Correctly expose the pinned Ghostty scrollback limit as bytes rather than lines.

### Commands, input, and extensions

- [x] Route existing pane/window mutations through a typed command dispatcher.
- [x] Provide fixed tmux-compatible `C-b` keyboard commands.
- [x] Preserve ordinary input order around prefix commands.
- [x] Normalize common legacy keys through Ghostty's canonical key encoder.
- [x] Run Lua 5.5 in an isolated daemon-managed process.
- [x] Register bounded transactional command, keymap, event, and sidebar generations.
- [x] Keep extension work after PTY, client-input, and rendering work.

### Validation

- [x] Maintain component and 12 process-level PTY tests.
- [x] Cover four host architectures in scheduled CI.
- [x] Run Linux ASan/UBSan in scheduled CI.
- [x] Maintain terminal, renderer, command, extension-codec, and process benchmarks.
- [x] Cover detach/reattach, split/window/zoom/resize, blocked PTY, slow client, fairness, and
      terminal-response/input ordering through the real process path.

# Foundation backlog

## Architecture-pivot closeout

- [x] Record the server-rendered decision directly in the architecture and product contracts.
- [x] Reject the smart-replica design.
- [x] Remove the nonproduction checkpoint prototype and replica-role API from the main build.
- [x] Preserve checkpoint findings and measurements as historical evidence.
- [x] Rewrite production contracts around daemon terminal/presentation authority.
- [x] Complete local validation after the pivot and record exact suite counts in
      `docs/current-capabilities.md`.

## Authoritative identities

- [ ] Move spaces into a dense generational store and assign `SpaceId`.
- [ ] Move panes into a dense generational store and assign `PaneId`.
- [ ] Assign `ClientId` to accepted, control, and attached clients.
- [ ] Preserve and integrate existing `WindowId` behavior.
- [ ] Resolve every explicit command target at the core trust boundary.
- [ ] Reject stale, cross-space, unauthorized, and type-confused IDs.
- [ ] Keep dense iteration and existing configured capacities.
- [ ] Add create/remove/reuse/wraparound/stale-ID tests for every store.

## Typed command results

- [ ] Give every command a closed target, argument, and result value.
- [ ] Distinguish success, no effect, capacity, unavailable, invalid target, and internal failure.
- [ ] Route keyboard, mouse, CLI, Lua, automation, and AI agents through one dispatcher.
- [ ] Keep physical rectangles and local slots out of public identities.
- [ ] Add deterministic mixed-command engine traces.

## Shared semantic automation spine

- [ ] Give each automation connection a stable `ClientId`, command origin, request ID, deadlines, and
      optional idempotency key for retry-safe mutations.
- [ ] Generate machine-readable command, value, result, error, capability, snapshot, and event schemas
      from one maintained semantic model.
- [ ] Add explicit `--format=json` context, list, inspect, launch, capture, wait, cancel, and topology
      operations without exposing private attach framing.
- [ ] Add a persistent same-user semantic socket for efficient scripts and AI agents.
- [ ] Add bounded immutable space/window/pane/process snapshots and observable generation changes.
- [ ] Add bounded lifecycle/topology/configuration events with explicit loss and snapshot repair.
- [ ] Add bounded pane output observation with sequence/gap identity, truncation, cancellation, and
      deadlines; do not turn it into terminal replication.
- [ ] Add canonical terminal capture of bounded visible/history ranges in plain text, with explicit
      ANSI/cell forms only where needed.
- [ ] Add server-side bounded wait-for-output and wait-for-exit operations to avoid polling loops.
- [ ] Add a typed launch contract for executable/arguments, cwd, environment, PTY, actor, and
      remain-on-exit policy.
- [ ] Preserve exit status/reason long enough for waiters and inspection before bounded reclamation.
- [ ] Add process-group signal/cancel/restart/close behavior with explicit destructive semantics.
- [ ] Inject bounded discoverable Lemma context into panes without treating environment variables as
      authority.
- [ ] Ship a maintained `SKILL.md` and end-to-end agent fixture that discovers the schema and completes
      run/capture/wait/cancel without screen scraping.
- [ ] Ensure every supported human mutation has an automation equivalent or documented exclusion.

## Private versioned attached-client protocol

- [ ] Define magic, major/minor version, kind, flags, length, and request correlation.
- [ ] Define hard frame, decoder, output, batch, aggregate-memory, and setup/progress limits.
- [ ] Add hello, version mismatch, attach, command, result, error, input, resize, render, effect, and
      detach values.
- [ ] Carry stable IDs in every explicit target.
- [ ] Frame daemon ANSI as complete bounded render messages.
- [ ] Preserve complete-frame boundaries across partial writes.
- [ ] Define full-redraw epochs for attach, window changes, resize, lag, and reconnect.
- [ ] Add a distinct migration endpoint and explicit old/new mismatch behavior.
- [ ] Add golden encodings, round trips, fragmentation/coalescing, malformed/oversized, version, ID,
      timeout, and capacity matrices.
- [ ] Add a bounded protocol fuzz corpus.
- [ ] Cut over only after old/new endpoints pass the same process scenarios.

## Bounded presentation recovery

- [ ] Keep at most the configured complete frame/output bound per attachment.
- [ ] Accumulate newer output as canonical terminal damage rather than queued render history.
- [ ] Force one full redraw after a blocked frame drains.
- [ ] Disconnect clients that miss a bounded write-progress deadline.
- [ ] Prove a blocked client cannot delay PTYs, control clients, or another space.
- [ ] Measure attach-to-visible, redraw recovery, bytes, and key-to-visible latency.

# Daily-driver capability backlog

## Startup, errors, and processes

- [ ] Implement plain `lemma` create-or-attach behavior for `default`.
- [ ] Add explicit `--help` and `--version`.
- [ ] Return nonzero for invalid commands and failed attached-client loops.
- [ ] Report capacity, no-effect, launch, and pane-exit status/reason visibly.
- [ ] Apply invoking-client cwd and bounded environment to new spaces.
- [ ] Apply focused-pane cwd fallback to splits and new windows.
- [ ] Add explicit daemon shutdown and safe no-space idle policy.
- [ ] Document endpoint, daemon, process, logout, shutdown, and reboot behavior.

## Windows, panes, layout, and status

- [ ] Add space rename and user-defined window names with rename commands.
- [ ] Add stable window reorder operations.
- [ ] Distinguish user name, foreground process, and terminal title in status.
- [ ] Store adjustable split ratios.
- [ ] Add keyboard pane-resize commands.
- [ ] Define minimum pane sizes, clamping, and deterministic ratio preservation.
- [ ] Add a bounded pane-identification overlay and public pane IDs.
- [ ] Test nested resize, tiny viewports, zoom, close, child exit, and resize storms.
- [ ] Benchmark layout work at 1, 4, 16, and 64 panes.

## Typed input and client lifecycle

- [ ] Define bounded key values including action, modifiers, codepoint, and text.
- [ ] Define bounded text/paste values with explicit paste boundaries.
- [ ] Define focus, resize, and mouse values.
- [ ] Preserve mixed key/text/paste/focus/mouse/command order.
- [ ] Decode legacy and supported extended keyboard protocols.
- [ ] Keep literal-prefix and bounded incomplete-sequence behavior.
- [ ] Detect bracketed paste so content cannot become mux commands.
- [ ] Enable only supported outer-terminal focus/mouse/keyboard modes.
- [ ] Restore termios, cursor, alternate screen, synchronized updates, paste, focus, keyboard, and
      mouse on normal, error, signal, disconnect, and partial-startup paths.
- [ ] Test client crash and daemon disconnect during every lifecycle stage.

## First-class mouse

- [ ] Decode click, release, motion/drag, wheel, button, modifiers, and cell coordinates.
- [ ] Bound or coalesce motion/wheel floods without reordering clicks or keys.
- [ ] Hit-test daemon-owned panes, separators, status, overlays, and selection.
- [ ] Dispatch keyboard and click focus through the same command.
- [ ] Dispatch keyboard resize and separator drag through the same ratio mutation.
- [ ] Translate application mouse input to validated pane-local coordinates.
- [ ] Encode application events through canonical terminal mouse modes.
- [ ] Implement configurable override of application mouse capture.
- [ ] Define alternate-scroll and focus-reporting behavior.
- [ ] Test claimed X10/normal/button/any-motion/SGR combinations.
- [ ] Benchmark click-to-focus, drag-to-layout, wheel, and pass-through latency.

## Copy mode, search, selection, and clipboard

- [ ] Add daemon-owned per-attachment viewport, copy cursor, follow-output, and unread-output state.
- [ ] Enter/leave copy mode without stopping PTY parsing or losing output.
- [ ] Traverse retained history by cell, line, page, word, top, and bottom.
- [ ] Add bounded forward/backward search with visible no-match behavior.
- [ ] Add one character/word/line selection model shared by keyboard and mouse.
- [ ] Handle graphemes, combining marks, wide cells, wrapping, and trailing spaces.
- [ ] Define linear/rectangular behavior and continuing-output behavior.
- [ ] Integrate the platform clipboard.
- [ ] Define bounded configurable OSC 52 policy.
- [ ] Define wheel behavior for normal, alternate, copy, and application-capture modes.
- [ ] Benchmark large-history navigation, search, wheel, and selection updates.

## Terminal compatibility

- [ ] Define and ship truthful `$TERM`/terminfo behavior.
- [ ] Verify UTF-8, graphemes, combining marks, wide cells, wrapping, tab stops, and resize reflow.
- [ ] Verify color/styles, cursor shapes, scroll regions, alternate screen, synchronized updates,
      paste, focus, hyperlinks, titles, bells, and terminal queries.
- [ ] Ensure pane modes never leak into status, separators, overlays, or copy mode.
- [ ] Document unsupported graphics/image protocols explicitly.
- [ ] Test zsh, bash, fish, Neovim, another editor, less/man, htop-class tools, REPLs, and TUIs.

# Programmability, extensions, and agent backlog

- [ ] Make `lemma.setup` validate and apply real settings transactionally.
- [ ] Install declarative keyboard and mouse maps into the typed command system.
- [ ] Keep built-in fallback bindings when configuration is missing or invalid.
- [ ] Invoke Lua command callbacks asynchronously.
- [ ] Deliver immutable snapshots and bounded lifecycle/topology/configuration events.
- [ ] Make event loss observable and repairable from snapshots.
- [ ] Implement replacement-host reload preserving the previous valid generation.
- [ ] Add file/line context to errors and generate active command/binding references.
- [ ] Add timers, asynchronous process APIs, and bounded pane-output subscriptions after the command/
      event foundation is stable enough to prove their bounds.
- [ ] Add declarative status, sidebar, notification, prompt, and overlay models retained by C++ and
      rendered without synchronous Lua calls.
- [ ] Support local versioned Lua packages/modules without requiring a marketplace.
- [ ] Build the shipped tmux-like standard layer from the same commands/settings/UI values exposed to
      user extensions, with a minimal C++ fallback when Lua is unavailable.
- [ ] Publish a first-party workspace extension that creates/selects repository worktrees, associates
      project metadata and layouts with one or more spaces, and launches project commands without a
      core `Workspace` type.
- [ ] Publish an agent-observer extension that proves working/blocked/done views require no core agent
      type.
- [ ] Keep provider-specific agent detection and orchestration in extensions rather than core stores.
- [ ] Test blocked/crashed host behavior during input, output, reload, and shutdown.
- [ ] Benchmark idle host overhead and keymap/command/automation dispatch latency.

# Remote, distribution, performance, and release backlog

## Ordinary SSH baseline

- [ ] Test `ssh -t HOST lemma` create/attach/input/resize/detach/client-loss behavior.
- [ ] Test machine-readable commands through ordinary SSH.
- [ ] Document remote host configuration, cwd/environment, logout, and daemon-lifetime behavior.
- [ ] Shape latency/bandwidth for observational performance tests without inventing a second protocol.

## Performance and robustness

- [ ] Measure key-to-PTY and key-to-visible p50/p95/p99 at idle and under output load.
- [ ] Measure sparse editor, full redraw, synchronized updates, and high-scroll workloads.
- [ ] Measure 1/4/16/maximum panes, active/inactive windows, status, and resize storms.
- [ ] Measure attach/full-redraw recovery, slow clients, blocked PTYs, and slow extension hosts.
- [ ] Measure JSON and persistent-agent command, snapshot, capture, wait, cancellation, and event
      latency/bytes under concurrent terminal load.
- [ ] Add checked-in workload adapters for pinned tmux, Zellij, Herdr, and Lemma versions; publish only
      comparable workload-specific claims rather than an unsupported universal “fastest” label.
- [ ] Measure idle CPU/wakeups, daemon baseline memory, per-pane/attachment memory, queue peaks, and
      client bytes.
- [ ] Set reviewed regression budgets after harnesses stabilize.
- [ ] Add property/model tests for generational stores and split trees.
- [ ] Fuzz control, attached-client, extension, and physical-input decoders.
- [ ] Stress attach/detach, client crashes, split/resize/focus/close, output floods, blocked peers,
      extension crashes, mouse floods, and resize storms.
- [ ] Test every capacity boundary and one-past failure.
- [ ] Run process tests under ASan/UBSan and all supported host architectures.
- [ ] Add a multi-day representative-shell/application soak.

## Distribution and adoption

- [ ] Add release metadata and changelog/upgrade policy.
- [ ] Produce checksummed macOS arm64/x86_64 archives.
- [ ] Produce checksummed Linux arm64/x86_64 archives.
- [ ] Test artifacts outside Nix/Conan/development shells.
- [ ] Write five-minute install/first-session, security, cleanup, and troubleshooting guides.
- [ ] Add shell completions and Homebrew packaging after artifact URLs stabilize.
- [ ] Add `CONTRIBUTING.md` and bounded starter issues.
- [ ] Recruit a focused external cohort.
- [ ] Record every reason users return to another terminal workflow.

# 1.0 release gate

- [ ] Every included feature satisfies the definition of done.
- [ ] Keyboard-only operation covers every core workflow.
- [ ] Mouse focus, resize, status, selection, scrolling, and application forwarding are tested.
- [ ] No supported client exit leaves outer-terminal state corrupted.
- [ ] Protocol/input fuzz, sanitizer, platform, stress, and soak suites pass.
- [ ] Performance has no unexplained regression outside reviewed budgets.
- [ ] Installation, upgrade, mismatch, and cleanup pass from release artifacts.
- [ ] Ordinary SSH behavior matches documented guarantees.
- [ ] Configuration, package, JSON automation, semantic RPC, schema, and compatibility policies are
      documented.
- [ ] An isolated agent fixture can discover Lemma and complete run/capture/wait/cancel plus topology
      mutation without screen scraping or arbitrary command strings.
- [ ] Every supported human mutation has an automation equivalent or documented exclusion.
- [ ] A focused external cohort uses Lemma as its primary mux for at least 30 days.
- [ ] Abandonment reasons are tracked, triaged, and reflected in the release decision.

# After 1.0

Evaluate from user evidence rather than precommitting the foundation:

- [ ] Add multiple viewers/controllers and explicit control transfer if demanded.
- [ ] Add a custom `lemma connect HOST` SSH-stdio transport if ordinary SSH is insufficient.
- [ ] Add extension marketplace discovery and broader UI surfaces if local package use proves demand.
- [ ] Evaluate native presentation using replaceable cell/style/cursor snapshots and deltas, never raw
      VT parser replication.

## Explicitly deferred

- Client terminal replicas and portable terminal checkpoints.
- Process/terminal survival across daemon death or reboot.
- Browser/mobile clients.
- User accounts or a hosted control plane.
- Native C++ plugin ABI.
- Live cross-host process migration.
