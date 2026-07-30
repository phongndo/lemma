# Fiber roadmap

## Status

This is a milestone roadmap, not a schedule or a promise that every listed feature already exists.
Audited user-facing behavior and foundation gaps are inventoried in
[`current-capabilities.md`](current-capabilities.md), implementation ownership remains documented in
[`single-pane-runtime.md`](single-pane-runtime.md), product guarantees remain governed by
[`product-contract.md`](product-contract.md), and the local quality bar is defined by
[`daily-driver-contract.md`](daily-driver-contract.md). Concrete work is tracked in the ordered
[`TODO.md`](../TODO.md) checklist, with the immediate hardening phase specified in
[`.plan/next-phase.md`](../.plan/next-phase.md).

## North star

**Fiber is a terminal multiplexer built like infrastructure.** It should provide fast, reliable,
self-hosted, programmable sessions that people, scripts, remote clients, and coding agents operate
through one semantic command model.

Fiber treats keyboard and mouse as first-class input methods. Keyboard operation remains complete,
while mouse interaction is designed into focus, resizing, selection, scrolling, status surfaces, and
application input rather than added as a compatibility layer. Both input paths converge on the same
validated commands and layout state where they express the same operation.

## Product principles

1. **Reliable by construction:** ownership, capacity, work, and failure behavior are explicit.
2. **Fast by measurement:** optimize user-visible latency and throughput with reproducible evidence.
3. **Keyboard-complete and mouse-native:** neither modality is an architectural afterthought.
4. **Depth before breadth:** complete and harden the day-to-day local mux before expanding scope.
5. **Programmable without blocking:** scripts and extensions use bounded asynchronous interfaces.
6. **Self-hosted by default:** local and remote operation do not require an account or hosted service.
7. **Honest releases:** distinguish implemented behavior, experimental APIs, and future direction.

## Current baseline

Fiber already has a working local vertical slice: a per-user daemon, named workspaces, windows,
split panes, fixed keyboard controls, retained damage rendering, a private `libghostty-vt` adapter,
typed commands for existing mutations, and an isolated Lua host with transactional registration.
The exact working, partial, scaffolded, and absent capabilities are audited in
[`current-capabilities.md`](current-capabilities.md).

The first foundation hardening slice is now implemented: accepted setup/control sockets are bounded
and nonblocking, every live pane has an ordered bounded PTY write queue, and isolated process-level
PTY tests protect the production daemon/client/shell lifecycle. Remaining foundation work is deeper
blocked-PTY stress and latency coverage before the authoritative-ID and versioned-protocol phase.
Daily-driver feature gaps still include copy and selection, first-class mouse routing, interactive
pane ratios, window naming, active configuration, release artifacts, and explicit durability
guarantees.

## Daily-driver foundation gate

The local mux is the foundation, not a temporary stepping stone to agents or remote services. Every
feature must meet the behavior, keyboard/mouse, ownership/bounds, testing, performance, failure, and
documentation completion rule in
[`daily-driver-contract.md`](daily-driver-contract.md). `v0.1` builds toward that contract and `v0.2`
must satisfy it. Work needed for safe configuration may continue, but `v0.3` programmability and
`v0.4` remote breadth do not take priority over an incomplete or unreliable daily-driver path.

## Decision gate — first release contract

Before calling a build `v0.1.0-alpha`, resolve and document:

- plain `fiber` startup and default-workspace behavior;
- process working-directory and environment inheritance;
- guarantees across detach, logout, daemon failure, and reboot;
- the initially supported macOS and Linux versions;
- copy-mode, clipboard, mouse-override, prefix, and default-key behavior;
- whether the project name is sufficiently distinctive before public adoption; and
- the public automation interface boundary: CLI output, local RPC, or both.

## v0.1 — installable local alpha

**Goal:** a new user can install Fiber, create a useful local workspace, and understand failures
without reading architecture documents.

### Runtime and protocol

- Move workspaces and panes to explicit generational IDs.
- Replace the development client protocol with a bounded, versioned envelope, capability
  negotiation, typed errors, and mismatch diagnostics.
- Define typed input messages for keys, bounded text/paste, focus, resize, and cell-based mouse
  events while preserving input order.
- Implement one end-to-end mouse slice: pane/status hit testing, click-to-focus/select, terminal
  application pass-through, and exact outer-terminal mode restoration.
- Ensure keyboard focus and selection invoke the same semantic commands as equivalent mouse actions.

### Local usability

- Define sensible plain `fiber` behavior.
- Add window naming and keyboard-driven pane resizing.
- Activate basic Lua settings and declarative keymaps in the C++ client/core path.
- Improve stale-daemon, capacity, child-launch, and protocol errors.

### Distribution

- Produce versioned macOS and Linux archives in GitHub Releases.
- Document a five-minute install and first-session path.
- Add shell completions and publish a short terminal recording.
- Add Homebrew packaging once release artifacts are stable.

### Exit criteria

- Installation does not require users to compile C++, Zig, or Ghostty.
- At least ten external users complete normal terminal work and report why they return to another
  multiplexer.
- Client/daemon version mismatches and mouse-mode cleanup fail safely and visibly.

## v0.2 — daily-driver release

**Goal:** satisfy [`daily-driver-contract.md`](daily-driver-contract.md) so common terminal workflows
no longer force users back to another multiplexer. Features are not complete until their normal,
capacity, malformed-input, cleanup, benchmark, and user-documentation paths are complete.

- Add copy mode, scrollback navigation, incremental search, selection, and clipboard integration.
- Support mouse selection, wheel scrolling, click-to-focus, status interaction, and drag resizing.
- Forward application mouse events according to the focused terminal's requested modes after
  translating coordinates into pane-local cells.
- Provide a configurable modifier that overrides application mouse capture for Fiber interaction.
- Complete configurable prefix/key tables and make every core operation keyboard-accessible.
- Finalize pane cwd/environment behavior and improve status/title behavior.
- Test shells, Neovim, REPLs, alternate screens, bracketed paste, focus events, and popular TUIs.
- Add long-running, slow-client, output-flood, malformed-input, and terminal-restoration tests.

### Exit criteria

- The complete daily-driver exit gate passes across behavior, performance, robustness,
  compatibility, installation, and upgrades.
- A focused cohort uses Fiber as its primary multiplexer for 30 days.
- Keyboard-only operation covers every core workflow; mouse workflows are tested rather than merely
  forwarded.
- No known supported interaction leaves the outer terminal in raw, alternate-screen, paste, focus,
  or mouse-tracking mode after the client exits.

## v0.3 — programmable Fiber

**Goal:** the extension and automation model becomes a reason to choose Fiber.

- Add asynchronous Lua command invocation, immutable snapshots, and bounded event delivery.
- Install transactional Lua keymaps and retained status/sidebar surfaces.
- Add timers, asynchronous process APIs, and bounded pane-output subscriptions.
- Implement replacement-host reload while preserving the prior valid generation.
- Expose machine-readable command results through a documented local automation boundary.
- Publish several maintained example extensions and API lifecycle guidance.

### Exit criteria

- A blocked, malformed, or crashed extension cannot delay PTY progress or end pane processes.
- Useful workflows can be built without modifying C++.
- Extension backpressure and event loss are observable and repairable from snapshots.

## v0.4 — remote, shared, and agent-driven sessions

**Goal:** the same Fiber model works across machines and software operators without a hosted control
plane.

- Add SSH-stdio transport and explicit remote launch/configuration behavior.
- Add per-client physical state, multi-client attachment, and viewer/controller permissions.
- Preserve typed keyboard, mouse, paste, resize, and focus semantics across transports.
- Expose the semantic command, snapshot, event, output, cancellation, and capacity APIs to agents.
- Add peer authentication rules, hostile-client tests, and security documentation.

### Exit criteria

A user can start work remotely, disconnect, inspect or control it through software, reattach from
another machine, and share explicitly scoped access without process loss from client failure.

## v1.0 — trusted infrastructure

Fiber reaches 1.0 when its guarantees are credible, not when it implements every command from another
multiplexer. The release requires:

- documented configuration, compatibility, security, and upgrade policies;
- explicit detach, daemon-failure, logout, and reboot guarantees;
- supported macOS and Linux packages;
- reliable cleanup and terminal restoration across keyboard and mouse paths;
- reproducible performance and resource-bound measurements;
- complete user, automation, and extension documentation; and
- a sustained community of daily users and contributors.

## Community and release work

Every milestone pairs engineering with adoption work:

- publish short development updates, recordings, and reproducible benchmarks;
- maintain a small feedback cohort before seeking broad attention;
- track repeat daily use and reasons for abandonment rather than stars alone;
- add contributor guidance and bounded starter issues;
- upstream relevant `libghostty-vt` fixes and document Fiber as a real consumer; and
- grow release volume only as fast as maintainership remains healthy.

## Explicitly deferred

Until terminal-native local and remote Fiber are excellent, defer web/mobile clients, accounts,
hosted control planes, extension package discovery, generalized task/run/view entities, production
orchestration, and feature-for-feature competition with other multiplexers.

## Immediate implementation sequence

1. Finish blocked-PTY stress/latency tests and the remaining detailed process-harness scenarios.
2. Resolve the remaining first-release decision gate in the product contract.
3. Introduce authoritative generational workspace/pane IDs and a versioned protocol envelope.
4. Add ordered typed keyboard, paste, focus, resize, and mouse values.
5. Deliver keyboard focus plus click-to-focus through one command path, including correct application
   mouse pass-through and terminal restoration.
6. Add plain-startup behavior, window naming, interactive pane resizing, and copy-mode foundations.
7. Build the first `v0.1.0-alpha` release artifacts and recruit the initial feedback cohort.
