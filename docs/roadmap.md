# Lemma roadmap

## Status

This is an outcome roadmap, not a schedule, fixed phase sequence, or implementation claim. Current behavior is audited
in [`current-capabilities.md`](current-capabilities.md), product guarantees in
[`product-contract.md`](product-contract.md), the quality bar in
[`daily-driver-contract.md`](daily-driver-contract.md), and operational detail in
[`../TODO.md`](../TODO.md).

[`../TODO.md`](../TODO.md) is the only execution backlog. This roadmap records desired outcomes,
ordering constraints, and release gates; neither document is a fixed implementation sequence.
Completed checkpoint evidence is retained in
[`terminal-checkpoint-feasibility.md`](terminal-checkpoint-feasibility.md), while current architecture
and product decisions live directly in their respective contracts.

## North star

**Lemma is a terminal multiplexer built like infrastructure.** It provides fast, reliable,
self-hosted, programmable sessions through one authoritative daemon and thin terminal clients.
People, scripts, remote shells, Lua extensions, and AI agents use one bounded semantic command model
without making a hosted service part of the runtime. The intended product shape is Pi-like: a small
high-performance kernel, a complete tmux-like standard layer, and replaceable workflow packages.

```text
PTY -> canonical daemon terminal -> daemon damage/layout compositor -> thin ANSI client
                                      ^
typed keys, mouse, CLI, Lua, scripts, agents +
```

The daemon owns processes, PTYs, topology, terminal truth, per-attachment view state, application
input encoding, and presentation. Clients own transport, physical input decoding, outer-terminal
writes, and cleanup. Attach and recovery always have a simple correctness path: regenerate a complete
visible frame from current daemon state.

## Product principles

1. **Reliable by construction:** ownership, capacity, work, and failure behavior are explicit.
2. **Fast by measurement:** optimize end-to-end latency, bytes, CPU, wakeups, and memory.
3. **One terminal authority:** no client VT replicas, parser replay, or checkpoint dependency.
4. **Keyboard-complete and mouse-native:** both paths converge on typed commands.
5. **Depth before breadth:** finish the daily-driver mux and semantic automation spine before shared
   or hosted features.
6. **Programmable without blocking:** Lua and agents use first-class typed values outside PTY/render
   hot paths.
7. **Self-hosted and SSH-friendly:** ordinary remote operation requires no Lemma service.
8. **Honest releases:** detach, daemon failure, logout, reboot, and compatibility limits are explicit.

## Current baseline

Lemma already has a working server-rendered local vertical slice: one per-user daemon, named
workspaces, windows, nested split panes, focus/zoom/resize/detach, bounded queues, canonical Ghostty
terminals, retained ANSI damage rendering, typed existing commands, and an isolated transactional Lua
host. The client is thin and forwards daemon-rendered output into an outer terminal.

P0 proved nonblocking accepted connections, bounded ordered PTY writes, slow-client and blocked-PTY
isolation, exact response/input ordering, topology lifecycle, and process continuity across detach and
client loss. The process benchmark records high-scroll and blocked-other-pane latency.

The checkpoint feasibility phase then proved that the pinned Ghostty API cannot reconstruct parser
continuation, both screens, and progressive history in a client replica. That result is now a closed
decision input rather than a release blocker: Lemma keeps terminal and presentation authority in the
daemon through 1.0.

## Outcome area — stable authoritative foundation

**Goal:** make every core object and client boundary explicit without changing terminal ownership.

- Move workspaces, panes, and clients into dense generational stores; retain `WindowId` behavior.
- Resolve every command target at the core trust boundary and return typed results/errors.
- Replace the development protocol with bounded versioned bidirectional framing.
- Frame daemon ANSI output as complete bounded render messages.
- Add protocol/version mismatch diagnostics and a distinct migration endpoint.
- Preserve full visible reconstruction for attach, resize, window change, reconnect, and lag recovery.
- Prove blocked clients retain only bounded presentation work and never stall PTYs.

### Exit criteria

- Every explicit target uses a validated stable ID.
- Both protocol directions are bounded, framed, versioned, fuzzed, and mismatch-safe.
- The existing process suite passes on the production endpoint.
- No checkpoint, raw event log, or client terminal is needed for correctness.

## Outcome area — complete local daily-driver UX

**Goal:** make Lemma credible as a primary local mux.

- Implement plain `lemma`, help/version, precise errors, cwd/environment policy, and exit reporting.
- Add workspace/window naming, stable reorder, pane identification, stored ratios, and keyboard resize.
- Add bounded typed key, text, paste, focus, resize, and mouse input.
- Complete signal-safe/best-available outer-terminal restoration.
- Add daemon-side status/pane/separator hit testing and application mouse forwarding.
- Add per-attachment copy mode, viewport, search, selection, and clipboard policy.
- Define truthful terminfo, keyboard, mouse, graphics, and terminal compatibility behavior.

### Exit criteria

- Every core workflow is keyboard-complete.
- Mouse focus, resize, status, selection, scrolling, and application forwarding are tested.
- Copy/search operates during continuing output without blocking PTYs.
- Representative shells, editors, pagers, REPLs, and TUIs pass the compatibility matrix.

## Outcome area — programmable and agent-friendly runtime

**Goal:** make Lemma a Pi-like mux runtime: a small high-performance kernel, a complete tmux-like
standard layer, and typed extension/automation surfaces shared by people, scripts, Lua, and AI agents.

- Define stable IDs, actors, typed commands/results/errors, schemas, snapshots, and bounded events
  before feature-specific interfaces diverge.
- Apply validated `lemma.setup` settings and declarative key/mouse maps transactionally.
- Invoke Lua commands asynchronously and add replacement-host reload preserving the prior generation.
- Expose explicit `--format=json` plus a versioned same-user semantic socket distinct from the private
  attached-client protocol.
- Support typed launch, inspect, capture, wait, cancel, signal, and exit-result operations.
- Make output/event loss bounded, observable, and repairable through capture/snapshots.
- Add declarative retained status/sidebar/overlay models and local versioned Lua packages.
- Ship maintained configuration examples, generated schema/binding references, and an agent `SKILL.md`.
- Prove the API with first-party workflow and agent-observer extensions rather than core agent types.

### Exit criteria

- Useful mux, project, and agent workflows require no C++ changes.
- Every supported human mutation has an automation equivalent or documented exclusion.
- An isolated agent can discover Lemma and complete run/capture/wait/cancel without screen scraping.
- A blocked, malformed, or crashed extension/agent cannot delay PTY, input, rendering, or processes.
- Event/output loss is observable and repairable from snapshots or bounded canonical capture.

## Outcome area — remote, distribution, and release hardening

**Goal:** turn the daily-driver into an installable, supportable product.

- Test `ssh -t HOST lemma` and machine-readable commands over ordinary SSH.
- Document host configuration, logout, daemon lifetime, shutdown, and reboot behavior.
- Produce checksummed macOS/Linux arm64/x86_64 archives and test outside development tooling.
- Add completions, onboarding, security, upgrades, cleanup, troubleshooting, and release notes.
- Complete protocol/input fuzzing, sanitizers, four-host CI, stress, output/resize floods, and soak.
- Establish reviewed latency, bytes, memory, CPU, wakeup, automation, and capture/wait budgets.
- Maintain comparable checked-in adapters for pinned tmux, Zellij, Herdr, and Lemma workloads.
- Recruit a focused external cohort and track reasons users return to another mux.

### Exit criteria

- Installation does not require compiling C++, Zig, or Ghostty.
- Local and ordinary-SSH compatibility suites pass on supported platforms.
- A focused cohort uses Lemma as its primary mux for at least 30 days.
- No unexplained correctness, cleanup, performance, or resource regression remains.

## 1.0 — trusted mux infrastructure

Lemma reaches 1.0 when these guarantees are credible:

- one documented authoritative server-rendered architecture;
- stable configuration, package, JSON/semantic automation, schema, upgrade, and private-protocol
  mismatch policies;
- explicit detach, logout, daemon-failure, shutdown, and reboot guarantees;
- reliable keyboard, mouse, copy, layout, terminal, and outer-terminal cleanup behavior;
- supported macOS/Linux packages;
- reproducible local/SSH performance and resource evidence;
- complete user, configuration, automation, security, and troubleshooting documentation; and
- sustained primary-mux use by external users.

1.0 requires the selected common tmux workflows, not syntax or edge-case parity with every tmux
command. It does not require native rendering, checkpointed clients, multiplayer, or process survival
across daemon death.

## After 1.0

Potential directions are evaluated from user evidence rather than precommitted architecture:

- multiple viewers/controllers and explicit permissions;
- a custom `lemma connect HOST` SSH-stdio transport;
- pipe-backed jobs or generalized tasks;
- extension marketplace discovery after local package use proves demand; and
- native presentation through replaceable cell/style/cursor snapshots and deltas.

A future native client never needs to replay raw PTY input. Browser/mobile clients, accounts, hosted
control planes, and live process migration remain explicitly deferred.

## Current priority guidance

This is guidance, not a fixed implementation sequence. Reorder the rolling `TODO.md` focus whenever a
small end-to-end spike, benchmark, user test, or dependency discovery changes the best next move.
Current highest-value work is:

- establish authoritative IDs, actor/request origins, and one typed command/result schema;
- prove a narrow command through C++, JSON, persistent agent access, and Lua before expanding breadth;
- define the common tmux-workflow parity matrix and build features as reusable semantic commands;
- version/frame the private attached-client path while preserving daemon rendering and P0 behavior;
- iterate daily-driver UX, extension primitives, and automation together so none becomes a wrapper;
- continuously test bounds and competitor workloads rather than postponing performance to closeout;
- package, test ordinary SSH, stress/soak, and recruit daily users only as implemented behavior earns it.
