# Lemma execution backlog

This is Lemma's only mutable execution backlog and source of current priority through 1.0.
[`docs/roadmap.md`](docs/roadmap.md) owns desired outcomes and release gates;
[`docs/current-capabilities.md`](docs/current-capabilities.md) audits what works today. Architecture and
product contracts are not task lists.

Unchecked boxes are unfinished work. A checked-in harness, a short qualification run, or a partial
report is not completion evidence. Update this file when priority or gate status changes, and update
the capability audit and affected contracts in the same change when shipped behavior changes.

## Current focus — close the F5 foundational mux gate

Product-surface expansion remains frozen until this gate closes. F0–F4 established the measured
workloads, interactive scheduler, core-owned bounded client output, memory ownership model, and
private attach protocol 1.0. F5 adds no product behavior; it validates that foundation under real
applications, repetition, sanitizers, resource measurement, and long-running mixed output.

### Evidence already completed

- [x] Release suite: 97 component cases, the standalone steady-state allocation audit, and 22
  process-level cases passed (120 CTest entries).
- [x] The allocation audit observed no C++ general allocation, general-allocation bytes, or new
  terminal-quota allocation over 10,000 warmed steady-state parse/damage/compose/flush iterations.
- [x] Locked bash, zsh, fish, Neovim, Vim, less, Python, and htop compatibility cases completed and
  restored the outer terminal.
- [x] Formatting, clang-tidy, clangd, workflow contracts, and the combined ASan/UBSan component and
  process suites passed.
- [x] Two-repetition release stress smoke and blocked-client smoke passed.
- [x] The 1,000-cycle create/attach/split/close/detach/kill run returned to a flat final RSS and
  descriptor plateau.
- [x] Thirty samples of every P1/P4/P16/PMAX idle and active profile were retained. Several unchanged
  latency and CPU budgets failed, so this is raw evidence rather than a passing gate.
- [x] Ten-second release and sanitizer soak qualifications passed. They do not count as the required
  24-hour runs.

The evidence-derived problems are listed in [`docs/issues.md`](docs/issues.md). Exact reports
and observed values are summarized in [`docs/performance.md`](docs/performance.md). Reproduction and
evidence-retention commands live in [`docs/operations.md`](docs/operations.md).

### Blocking work, in order

1. [ ] Explain and remove the finite-gate failures rather than hiding them with partial reports or
   wider limits.
   - Reproduce and diagnose the P1/P16 idle latency, active P1/P4/P16/PMAX latency, and active CPU
     failures.
   - Reproduce the full-process blocked-client case that exceeded the 5 s deadline plus 0.5 s
     observation bound.
   - Distinguish code effects from host scheduling with paired raw evidence. Fix code regressions;
     keep environment-only failures explicit.
   - Resolve the pinned-host identity mismatch by running on the reviewed identity or by reviewing a
     new dedicated-host distribution and manifest. Do not bypass machine-scope validation.
2. [ ] Produce one successful aggregate finite result with
   `nix develop --command scripts/ci/f5 extended`. It must include the 20-repetition release and
   sanitizer stress lanes, complete process/profile reports, 1,000 lifecycle cycles, allocation and
   compatibility evidence, and a passing reviewed-budget evaluation.
3. [ ] Run and retain the optimized release soak:
   `nix develop --command scripts/ci/f5-soak release 86400 300`.
4. [ ] Run and retain the ASan/UBSan soak:
   `nix develop --command scripts/ci/f5-soak sanitizers 86400 300`.
5. [ ] Review the complete `build/release/f5-*` artifact set together. Both long-soak JSON reports
   must say `completed`, record requested and elapsed duration of at least 86,400 seconds, preserve
   exact-token interaction and terminal restoration, and contain no unexplained resource,
   descriptor, sanitizer, or correctness regression.
6. [ ] Refresh the capability, performance, operations, and quality documents from the reviewed raw
   reports, then mark the foundational mux gate complete here. Do not infer completion from command
   availability or short runs.

## Next — complete the unconfigured local daily driver

Start this section only after F5 closes. Ship each item as a bounded end-to-end slice with documented
success/failure behavior, explicit limits, component/process tests, and measurements for changed hot
paths. Preserve the permanent invariants in
[`docs/core-mux-quality.md`](docs/core-mux-quality.md).

### Lifecycle, naming, and layout

- [ ] Report exact pane launch/exit reason and status, capacity outcomes, and no-effect command
  results to attached users without compromising terminal cleanup.
- [ ] Add session and tab rename, stable tab reorder, and useful pane identification using validated
  generational targets.
- [ ] Store split ratios and support bounded keyboard resize; rejected or too-small layouts must not
  partially mutate topology.
- [ ] Complete focused-process cwd policy for new panes/tabs, or retain and document the session-cwd
  policy as the deliberate 1.0 contract.

### Typed input and terminal compatibility

- [ ] Decode and bound Unicode, Alt, function, navigation, modifier, repeat, and Kitty keyboard input
  into typed events before encoding it for the focused application.
- [ ] Represent paste and focus as bounded semantic events so prefix handling cannot corrupt their
  boundaries.
- [ ] Define and test truthful terminfo, keyboard, color, mouse, graphics, and unsupported-feature
  behavior across the supported terminal matrix.
- [ ] Keep outer-terminal restoration complete on normal exit, partial startup, disconnect, daemon
  loss, and every handled signal as the input surface expands.

### Mouse, history, and copy

- [ ] Add daemon-side status, pane, and separator hit testing; translate application mouse events to
  pane-local coordinates and define capture/forwarding precedence.
- [ ] Add keyboard and mouse focus/resize/status operations through the same typed command model.
- [ ] Add a bounded per-attachment history viewport and copy mode while PTY parsing continues.
- [ ] Add incremental search, keyboard/mouse selection, correct wrapped-line extraction, and an
  explicit bounded clipboard policy.

### Daily-driver gate

- [ ] Pass every L/T/P/I/H/R/C/O workflow required by
  [`docs/core-mux-quality.md`](docs/core-mux-quality.md), including representative shells, editors,
  pagers, REPLs, and TUIs locally.
- [ ] Keep blocked PTYs, clients, and optional subsystems isolated; keep presentation repair bounded
  by full redraw or disconnect; keep steady-state parse/compose/flush allocation-free.
- [ ] Publish reviewed latency, bytes, CPU, wakeup, memory, compatibility, and cleanup evidence for
  the completed input/mouse/copy surface.

## Then — expose the programmable semantic spine

Do not turn the private attached-client stream into an accidental public API. Human keys, mouse,
CLI, Lua, scripts, and agents must converge on validated commands and typed results.

- [ ] Define public hierarchical IDs, actors, request identity, typed commands/results/errors,
  immutable snapshots, bounded events, schema discovery, and compatibility policy.
- [ ] Add explicit `--format=json` and a versioned same-user semantic socket distinct from private
  attach protocol 1.0; reject malformed or stale targets before mutation.
- [ ] Add bounded launch, inspect, capture, wait, cancel, signal, and exit-result operations. Make
  output/event loss observable and repairable from capture or snapshots.
- [ ] Apply `lemma.setup` and declarative key/mouse maps transactionally.
- [ ] Invoke Lua commands asynchronously and add replacement-host reload while preserving the prior
  valid generation on failure.
- [ ] Deliver bounded events/snapshots and retained sidebar/status/overlay models without putting Lua
  or agent work on PTY, input, or render hot paths.
- [ ] Ship generated schema/binding references, maintained configuration examples, local versioned
  package conventions, and an agent `SKILL.md`.
- [ ] Prove the boundary with first-party workspace/worktree and agent-observer packages rather than
  adding workspace, task, or agent containers to the kernel.

### Programmability gate

- [ ] Every supported human mutation has an automation equivalent or a documented exclusion.
- [ ] An isolated agent can discover the API and complete launch/capture/wait/cancel without screen
  scraping.
- [ ] A blocked, malformed, or crashed extension or agent cannot delay PTY, input, rendering, or pane
  processes, and all retained work remains bounded.

## Finally — remote, distribution, and 1.0 release

- [ ] Validate the supported interaction and machine-readable command baseline through ordinary
  `ssh -t HOST lemma`; document host setup, logout, daemon lifetime, shutdown, and reboot behavior.
- [ ] Produce checksummed macOS and Linux arm64/x86_64 archives and test installation, upgrade, and
  removal outside Nix and the source tree.
- [ ] Add completions, onboarding, configuration, security, upgrade, cleanup, troubleshooting, and
  release documentation.
- [ ] Complete protocol/input fuzzing, four-host sanitizer/stress/soak coverage, and reviewed local
  and SSH latency, bytes, memory, CPU, wakeup, automation, and capture/wait budgets.
- [ ] Keep checked-in Lemma, tmux, Zellij, and Herdr workload adapters comparable and retain
  incomplete competitor work as failure rather than a fast sample.
- [ ] Recruit a focused external cohort, track reasons users return to another mux, and demonstrate
  sustained primary-mux use for at least 30 days.
- [ ] Satisfy every 1.0 guarantee in [`docs/roadmap.md`](docs/roadmap.md) and publish an audited
  capability inventory with no implied support for deferred behavior.

## Deferred until after 1.0

Multiple viewers/controllers, custom `lemma connect HOST` transport, generalized tasks, extension
marketplace discovery, native presentation, browser/mobile clients, hosted control planes, and
process survival across daemon death are not current execution work. Promote one only by updating the
product contract, roadmap guidance, and this backlog from user evidence.
