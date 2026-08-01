# Lemma roadmap

## Status

This is a milestone roadmap, not a schedule or a claim that every listed feature exists. Audited
behavior belongs in [`current-capabilities.md`](current-capabilities.md), current implementation
ownership in [`single-pane-runtime.md`](single-pane-runtime.md), product guarantees in
[`product-contract.md`](product-contract.md), and the quality bar in
[`daily-driver-contract.md`](daily-driver-contract.md). [`../TODO.md`](../TODO.md) is the operational
checklist and defines the numbered phase-plan convention.

The completed P0 record is
[`001-p0-local-mux-hardening.md`](../.plan/001-p0-local-mux-hardening.md). The active next phase is the
checkpoint feasibility gate in
[`002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md); the
contingent implementation plan is
[`003-replicated-terminal-foundation.md`](../.plan/003-replicated-terminal-foundation.md).

## North star

**Lemma is a terminal multiplexer built like infrastructure.** It provides fast, reliable,
self-hosted, programmable sessions through one checkpointed terminal-replication protocol used by
local clients, remote clients, automation, and future native presentation.

The authoritative daemon owns processes, PTYs, topology, terminal truth, input order, and extension
state. Smart clients attach from terminal checkpoints, apply ordered pane events, own their local
viewports and presentation, and recover from lag or reconnect through the same checkpoint mechanism.
ANSI is a compatibility presentation backend in a smart client, not a second daemon output
architecture.

## Product principles

1. **Reliable by construction:** ownership, capacity, work, synchronization, and failure behavior are
   explicit.
2. **Fast by measurement:** optimize key-to-visible latency, throughput, attach time, and bytes across
   local and shaped remote transports.
3. **One replication architecture:** checkpoint plus ordered event tail is the attachment, live,
   reconnect, and recovery model.
4. **Keyboard-complete and mouse-native:** neither modality is an architectural afterthought.
5. **Depth before breadth:** complete and harden the daily-driver path before broad product surface.
6. **Programmable without blocking:** scripts and extensions use bounded asynchronous semantic
   interfaces outside the terminal data path.
7. **Self-hosted and remote-capable by design:** Unix sockets and SSH stdio carry the same application
   protocol without requiring an account or hosted service.
8. **Honest releases:** current server-rendered behavior, transitional migration paths, and target
   native behavior are labeled separately.

## Current baseline

Lemma has a working server-rendered local vertical slice: a per-user daemon, named workspaces,
windows, split panes, fixed keyboard controls, retained ANSI damage rendering, one canonical private
`libghostty-vt` terminal per pane, typed commands for existing mutations, and an isolated Lua host
with transactional registration. The current client is stateless with respect to pane terminals and
forwards daemon-rendered ANSI to an outer terminal.

P0 is complete: accepted setup/control sockets are bounded and nonblocking, every live pane has an
ordered bounded PTY write queue, deterministic component tests cover partial writes, budgets, and
response/input ordering, and 12 isolated process tests cover lifecycle, topology controls, adversarial
setup peers, slow readers, blocked-PTY recovery, response delivery, and fairness. The process benchmark
records warm-scroll traffic and blocked-other-pane latency.

That implementation remains the protected migration baseline. The next architecture replaces its
attached-output boundary; it does not invalidate its daemon ownership, topology, commands,
backpressure, tests, or benchmark infrastructure.

## Architecture decision and feasibility gate

Lemma has selected one target client architecture:

```text
terminal checkpoint at N -> ready -> ordered output/resize/reset/exit events after N
```

The daemon retains canonical `libghostty` state. Every smart client owns expendable replica terminals
and presentation. A lagging or reconnecting replica resumes from retained events only when safe;
otherwise it resets from a fresh checkpoint. Progressive scrollback is transferred separately from
the visible ready path.

The pinned `libghostty-vt` API does not yet expose a complete portable terminal checkpoint
export/import contract. The numbered `.plan/002` feasibility phase—not release v0.2—must prove
deterministic continuation, side-effect suppression, bounds, and performance before the generalized
output wire is frozen. A failed feasibility gate requires an explicit architecture review, not an
incomplete checkpoint format.

## Daily-driver foundation gate

The local mux remains the quality foundation, but SSH transport correctness is now validated during
the replication foundation rather than postponed until after the protocol hardens. This is transport
proof, not permission to prioritize multiplayer, agents, web/mobile, or broad remote UX over the
daily driver.

Every feature must satisfy [`daily-driver-contract.md`](daily-driver-contract.md). `v0.1` proves and
packages the replication architecture; `v0.2` must satisfy the complete native daily-driver gate.
Programmability breadth and shared/agent operation do not bypass those gates.

## v0.1 — installable replicated-terminal alpha

**Goal:** ship one bounded client/daemon architecture locally and over an SSH proof path, while
preserving a usable terminal-hosted presentation during native-client development.

### Foundation

- Pass the complete terminal-checkpoint feasibility gate or stop for architecture review.
- Move workspaces, panes, and clients to explicit generational IDs.
- Replace the development protocol with a bounded, versioned, bidirectional envelope carrying typed
  errors, capabilities, requests, results, topology, checkpoints, ordered pane events, input,
  acknowledgements, and resynchronization.
- Give every pane one authoritative event sequence covering output, resize, reset, and exit.
- Prove checkpoint `N` plus the event tail is equivalent to uninterrupted canonical parsing.
- Bound per-client lag and recover through a fresh reset/checkpoint without blocking PTYs.

### Smart client and presentation

- Give the client bounded terminal replica stores and synchronization state.
- Move the tested ANSI compositor behind the smart compatibility client so current terminal-hosted
  UX consumes the final replication protocol.
- Replicate multi-pane topology and render status, separators, overlays, cursor, and terminal modes
  from client-side replicas.
- Remove daemon-to-attached-client unframed/composed ANSI after cutover; retain the old endpoint only
  as temporary migration scaffolding.
- Define typed key, text/paste, focus, resize-request, and mouse messages while preserving order.

### Remote proof

- Run the same protocol over Unix sockets and SSH stdio.
- Test initial attach, progressive history, disconnect, resume, forced fresh checkpoint, version
  mismatch, and slow-link boundedness under shaped network conditions.
- Keep exact remote CLI/config synchronization UX limited until its later product contract is
  selected.

### Local usability and distribution

- Implement the contracted plain-`lemma` default workspace, cwd/environment capture, errors, and
  login-shell behavior.
- Add version metadata identifying Lemma protocol and terminal-checkpoint compatibility.
- Produce checksummed macOS/Linux archives and a five-minute install/first-session guide.
- Add shell completions and recruit the first external architecture-testing cohort.

### Exit criteria

- One production daemon attached-output protocol exists: checkpoint plus ordered events.
- Local and SSH clients pass the same protocol, synchronization, malformed-input, and lifecycle
  suites.
- Client lag is bounded and demonstrated to recover without PTY or unrelated-client stalls.
- The compatibility client remains usable in representative outer terminals.
- Installation does not require users to compile C++, Zig, or Ghostty.
- Results are labeled honestly: native GPU performance is not claimed until the native path exists.

## v0.2 — native daily-driver release

**Goal:** satisfy [`daily-driver-contract.md`](daily-driver-contract.md) with client-side native
presentation and remote attachment credible for daily terminal work.

- Deliver the primary native client renderer over the same replica model and protocol.
- Add native tabs/windows/splits, client-side Lemma chrome hit testing, and exact logical-topology
  command validation by the daemon.
- Add window naming, adjustable split ratios, keyboard resizing, mouse focus/status selection, and
  separator dragging.
- Add client-local copy mode, progressively hydrated scrollback, search, selection, and clipboard
  integration.
- Forward application mouse input with stable pane IDs and pane-local coordinates encoded by the
  authoritative terminal modes.
- Complete configurable prefix/key tables, settings, declarative keymaps, and keyboard access to all
  workflows.
- Finalize controller dimension policy, control transfer prerequisites, title/status behavior, and
  pane cwd/environment behavior.
- Test shells, Neovim, REPLs, alternate screens, bracketed paste, focus, graphics policy, and popular
  TUIs locally and through SSH.
- Add long-running, lagging-client, output-flood, reconnect, resize-storm, checkpoint-corruption,
  malformed-input, and presentation-cleanup tests.

### Exit criteria

- The complete daily-driver gate passes across behavior, native/compatibility presentation,
  performance, robustness, local/SSH transport, installation, and upgrades.
- A focused cohort uses Lemma as its primary multiplexer for 30 days.
- Keyboard-only operation covers every core workflow; mouse workflows are tested rather than merely
  forwarded.
- Checkpoint plus tail equivalence holds across the supported terminal compatibility corpus.
- No supported compatibility-client exit path leaves the outer terminal in raw, alternate-screen,
  paste, focus, keyboard, or mouse mode.

## v0.3 — programmable Lemma

**Goal:** the extension and automation model becomes a reason to choose Lemma without entering the
terminal replication hot path.

- Add asynchronous Lua command invocation, immutable snapshots, and bounded event delivery.
- Install transactional Lua keymaps and distribute retained declarative status/sidebar models to
  clients for rendering.
- Add timers, asynchronous process APIs, and bounded pane-output subscriptions.
- Implement replacement-host reload while preserving the prior valid generation.
- Expose machine-readable command results through a documented local automation boundary.
- Publish maintained example extensions and API lifecycle guidance.

### Exit criteria

- A blocked, malformed, or crashed extension cannot delay PTY, checkpoint, client synchronization,
  or pane-process progress.
- Useful workflows can be built without modifying C++.
- Extension backpressure and event loss are observable and repairable from snapshots.

## v0.4 — shared and agent-driven Lemma

**Goal:** extend the already remote-capable terminal protocol to multiple people and software
operators without a hosted control plane.

- Support multiple attached clients and independent replica/view state.
- Add explicit viewer/controller permissions, control transfer, and canonical dimension policy.
- Preserve typed keyboard, mouse, paste, focus, resize, command, and terminal-event ordering across
  participants.
- Expose commands, snapshots, events, output, cancellation, and capacity to coding agents.
- Define remote daemon bootstrap, config synchronization, upgrade, and optional advanced transport
  behavior.
- Add peer authentication rules, hostile-client tests, and security documentation.

### Exit criteria

A user can start work remotely, disconnect, inspect or control it through software, reattach from
another machine, and share explicitly scoped access without process loss or replica corruption from
client failure.

## v1.0 — trusted infrastructure

Lemma reaches 1.0 when its guarantees are credible, not when it implements every command from another
multiplexer. The release requires:

- documented configuration, checkpoint/protocol compatibility, security, and upgrade policies;
- explicit detach, daemon-failure, logout, and reboot guarantees;
- supported macOS and Linux packages;
- reliable native and compatibility presentation cleanup;
- reproducible local/remote performance and resource-bound measurements;
- complete user, automation, extension, and synchronization troubleshooting documentation; and
- sustained daily use and a healthy contributor community.

## Community and release work

Every milestone pairs engineering with adoption work:

- publish architecture notes, recordings, and reproducible benchmarks;
- maintain a small feedback cohort before seeking broad attention;
- track repeat daily use and reasons for abandonment rather than stars alone;
- add contributor guidance and bounded starter issues;
- upstream the checkpoint/import capabilities Lemma needs from `libghostty-vt`; and
- grow release volume only as fast as maintainership remains healthy.

## Explicitly deferred

Until terminal-native local and remote Lemma are excellent, defer web/mobile clients, accounts,
hosted control planes, extension package discovery, generalized task/run/view entities, production
orchestration, and feature-for-feature competition with every multiplexer. Browser or mobile
feasibility must reuse the same replica protocol and does not justify a second terminal architecture.

## Immediate implementation sequence

1. Complete and preserve the P0 closeout as the server-rendered migration baseline.
2. Execute [`.plan/002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md):
   state inventory, portable export/import design, equivalence harness, side-effect policy, and
   checkpoint size/time measurements.
3. Review the gate. If it passes, execute
   [`.plan/003-replicated-terminal-foundation.md`](../.plan/003-replicated-terminal-foundation.md).
4. Introduce authoritative generational workspace, pane, and client IDs.
5. Build the bounded versioned checkpoint/event protocol and one-pane smart replica.
6. Add acknowledgement, reconnect, and forced resynchronization with explicit capacity behavior.
7. Move multi-pane ANSI composition into the client and cut over from daemon ANSI output.
8. Prove the same protocol over SSH with shaped-link benchmarks.
9. Continue typed input, native mouse, layout, copy-mode, usability, and release work on that single
   architecture.
