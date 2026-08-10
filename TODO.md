# Foundational mux execution plan

This is Lemma's sole mutable execution backlog. The current goal is intentionally narrow:

> Build the smallest robust local terminal multiplexer with excellent latency, throughput, memory
> use, isolation, and terminal correctness.

Work on packages, agent APIs, public automation, extensible UI, mouse, copy mode, broad configuration,
multiple viewers, reboot persistence, and custom remote transport is frozen. Existing extension code
may remain, but it must not expand or affect the foundational acceptance path.

The completed `Session -> Tab -> Pane` hierarchy, authoritative daemon, daemon-owned Ghostty
terminals, bounded single-owner reactor, and thin ANSI client remain the architecture. Revisit them
only if reproducible evidence disproves an invariant or exposes an unfixable performance limit.

## Foundation boundary

The milestone includes:

- one per-user local daemon;
- named sessions with attach/detach continuity;
- tabs and horizontal/vertical pane splits;
- focus, close, zoom, and terminal resize;
- process and PTY ownership;
- ordered keyboard input and terminal responses;
- canonical terminal parsing and bounded damage composition;
- one attached client per session;
- a minimal built-in status line and prefix keymap;
- bounded queues, fair reactor work, and reliable outer-terminal cleanup.

It does not include new workflow or platform features. A task enters this plan only when it improves
or proves the performance, efficiency, boundedness, correctness, or maintainability of that
foundation.

## Working rules

1. Measure end to end; implementation language and microbenchmarks are not product evidence.
2. Record p50, p95, p99, raw samples, bytes, CPU, wakeups, and memory where applicable.
3. Optimize measured dominant costs rather than presumed costs.
4. Keep every queue, payload, allocation, batch, and reactor turn explicitly bounded.
5. Preserve input/terminal-response ordering and complete visible-state recovery.
6. Do not trade unrelated-session fairness or terminal correctness for a headline throughput result.
7. Do not add frameworks, general APIs, or abstractions without a current foundational use.
8. Do not refactor `src/core/engine.cpp` solely because it is large; extract only independently
   testable policy or ownership boundaries needed by this plan.
9. Each hot-path change must include a release benchmark comparison against its parent commit.
10. A failed or incomplete workload is a failure, never a fast sample.

## Current focus — F0: lock the baseline and expose latency

Before changing scheduling policy, make the complete path observable and characterize normal
variance on a dedicated host.

- [x] Run clean release microbenchmarks and at least five complete Lemma/tmux comparison repetitions;
      retain raw reports under `build/release/` and summarize the environment and results in
      `docs/performance.md`.
- [x] Add an opt-in, low-overhead diagnostic trace for these monotonic timestamps:
  1. attached client reads physical input;
  2. daemon receives the input message;
  3. daemon writes the focused PTY;
  4. daemon reads resulting PTY output;
  5. Ghostty reports presentation damage;
  6. frame composition starts and finishes;
  7. daemon makes socket-write progress;
  8. client receives and writes the frame to the outer terminal.
- [x] Keep tracing disabled in normal release builds and prove that enabling it has a measured,
      reported overhead.
- [x] Add attach-to-visible latency and same-pane interactive-under-output workloads to
      `benchmarks/mux_benchmark.py`.
- [x] Extend resource measurement to distinguish daemon, attached client, and optional extension host
      instead of reporting only a process-tree total.
- [x] Measure P1, P4, P16, and PMAX idle and active profiles from `benchmarks/workloads.json`.
- [x] Record system calls or wakeups for an idle attached session using a reviewed platform mechanism;
      report unavailable rather than substituting an unrelated counter.
- [x] Establish reviewed regression budgets only after the sample distributions are known.

### F0 completion gate

- The fixed 2 ms floor and every other material key-to-visible stage can be identified separately.
- Baseline reports are reproducible from checked-in commands and contain raw samples and provenance.
- P1/P4/P16/PMAX baseline memory, CPU, and latency are known.
- Benchmark tracing does not silently become production hot-path work.

## F1: remove the interactive latency floor

Replace the boolean immediate/delayed scheduling convention in `src/core/engine.cpp` with a small,
deterministically testable urgency policy.

- [x] Define explicit frame urgency such as `interactive`, `state_change`, and `burst`.
- [x] Mark accepted input for the focused pane as latency-sensitive without introducing an unbounded
      causal log.
- [x] Render the first resulting visible damage immediately.
- [x] Render focus, layout, resize, attach, exit, and status mutations immediately.
- [x] Retain bounded coalescing for sustained autonomous output.
- [x] Keep at most one pending deadline and let higher urgency advance, never postpone, it.
- [x] Ensure no rendering timer or periodic wakeup exists while idle.
- [x] Add deterministic scheduler tests for deadline promotion, burst continuation, blocked output,
      resize, detach, and no-client cases.
- [x] Measure idle and loaded key-to-PTY/key-to-visible distributions before and after the change.

### F1 provisional performance gate

- Remove the approximately 2 ms key-to-visible floor.
- Reach local key-to-visible p50 at or below 250 us and p95 at or below 1 ms on the pinned development
  machine, then tighten or revise these budgets from evidence.
- Preserve current key-to-PTY behavior.
- Regress warm-scroll latency, emitted bytes, or renderer CPU by no more than 5% outside established
  benchmark variance.
- Produce no periodic idle wakeups attributable to frame scheduling.

F1 completed on the pinned development host with 200/200 exact causal paths and no trace drops. The
PTY-output-to-composition interval fell from 2.336 ms p50 to 18 us p50, and physical input to outer
write completion fell from 2.580/2.764/3.172 ms to 0.180/0.226/0.244 ms p50/p95/p99. Thirty-sample
idle and blocked-peer key-to-visible distributions were 0.168/0.234 ms and 0.227/0.257 ms p50/p95;
all idle profile wakeup samples remained zero. The reviewed gate now has 68 checks and tighter F1
idle and loaded latency limits. Raw report names and the complete before/after accounting are in
`docs/performance.md`.

## F2: make output progress and reactor fairness explicit

Rendering should produce bounded bytes; the core reactor should own descriptor progress and fairness.

- [ ] Remove `send()` from `src/render/single_pane.cpp`; make composition only fill retained bounded
      frame state.
- [ ] Move attached-client writes behind a core-owned bounded flush operation with injectable unit-test
      writers, matching the PTY and pending-control output patterns.
- [ ] Add a daemon-wide attached-client write budget and a round-robin cursor so session iteration
      order cannot dominate progress.
- [ ] Record output progress time and disconnect a client that exceeds a reviewed no-progress or total
      frame deadline.
- [ ] Preserve one retained frame per attached client; accumulate later changes as canonical terminal
      damage and repair with a complete redraw when required.
- [ ] Measure whether draining every ready PTY before client input harms loaded p95/p99 latency.
- [ ] If measured, introduce a bounded latency lane that first drains output required for the focused
      pane's terminal-response ordering, handles client input, and then round-robins bulk PTY work.
- [ ] Preserve the 256 KiB global PTY-read bound and per-pane/global PTY-write bounds unless a benchmark
      and isolation test justify a reviewed change.
- [ ] Add blocked-client, many-writable-client, flooded-pane, and session-order fairness tests.

### F2 completion gate

- A blocked attached client has bounded memory, CPU, and lifetime.
- No socket write occurs in the render subsystem.
- A flooded or blocked session increases unrelated key-to-visible p95 by less than 10% on the pinned
  workload, or a stricter evidence-based budget.
- Every ready class makes bounded progress without descriptor-order starvation.
- Warm-scroll and sparse-frame advantages remain intact.

## F3: reduce baseline and marginal memory

Measure memory as:

```text
M(N, H) = M_base + N * M_pane + M_history(H) + M_fragmentation
```

Do not count configured hard maxima as acceptable resident cost.

- [ ] Produce a byte-level ownership census for daemon baseline, session, tab, pane, terminal,
      scrollback, decoder, frame, PTY queue, pending connection, and extension-host state.
- [ ] Replace the 64 KiB eager output array in every pending-connection slot with lazy storage or a
      bounded shared pool; preserve aggregate and per-connection limits.
- [ ] Allocate frame storage only for attached sessions and release it on detach when evidence shows
      that doing so improves resident memory without attach churn or fragmentation regressions.
- [ ] Replace the eager 4 MiB frame allocation with bounded viewport-derived capacity that grows only
      on attach/resize and performs no steady-state render allocation.
- [ ] Verify that PTY write queues and Ghostty scrollback grow lazily and remain under daemon-wide and
      per-pane bounds.
- [ ] Measure allocator retention and fragmentation after repeated create/split/close/attach/detach
      cycles.
- [ ] Record stripped executable sizes and dependency/process contributions; make the extension host
      lazy or absent from the foundational path if it contributes idle cost without configuration.

### F3 completion gate

- Baseline and marginal pane/session/history costs are documented and covered by process tests.
- No data structure eagerly allocates proportional to daemon hard maxima unless required by measured
  hot-path performance and explicitly justified.
- Target P1 idle process-tree RSS at no more than 1.5x pinned tmux under identical completion
  semantics. If this is not achievable, stop and review the measured irreducible owner rather than
  weakening or hiding the metric.
- Repeated lifecycle and output workloads return to a stable memory plateau.
- Rendering remains allocation-free after attach/resize capacity is established.

## F4: bound and version the private attach path

Implement only the private protocol needed by the foundational mux. Do not introduce a public RPC or
semantic automation system.

- [ ] Replace `lemma-v9` with one versioned, bidirectionally framed protocol.
- [ ] Limit the message set to hello/version, input, resize, pane command, detach, complete render
      frame, full-redraw generation, and typed error/disconnect reason.
- [ ] Validate every type, length, enum, dimension, sequence, and version before mutation.
- [ ] Add bounded incremental decoders to both daemon and client.
- [ ] Preserve partial-read/write behavior and the output progress policy from F2.
- [ ] Reject incompatible peers with an actionable diagnostic and no partial attach.
- [ ] Add golden, fragmented, coalesced, malformed, oversized, mismatch, partial-write, blocked-peer,
      reconnect, and full-redraw recovery tests.
- [ ] Make attached-client terminal restoration reliable on normal exit, startup failure, daemon loss,
      EOF, and every handled signal.
- [ ] Re-run all performance suites and account for framing overhead explicitly.

### F4 completion gate

- Both directions are bounded and framed; daemon ANSI is never an ambiguous socket byte stream.
- Attach, resize, tab switch, reconnect, and lag repair reconstruct complete visible state.
- Incompatible and malicious local peers have bounded impact and precise outcomes.
- Framing causes no material interactive-latency regression and no more than 5% byte/CPU regression
  outside measured variance.
- Outer-terminal modes are restored on every tested exit path.

## F5: prove and freeze the foundational mux

This milestone adds no product features. It closes correctness and performance evidence.

- [ ] Validate representative shells, editors, pagers, REPLs, and full-screen TUIs.
- [ ] Run rapid resize, output flood, child-exit, capacity, attach/detach, malformed-peer, blocked-PTY,
      and blocked-client stress suites.
- [ ] Complete at least 1,000 repeated create/attach/detach/close lifecycle cycles without leaks,
      stale identity, terminal leakage, or unbounded resource growth.
- [ ] Complete a 24-hour mixed-output soak under ASan/UBSan where practical and an optimized release
      soak for performance/resource evidence.
- [ ] Run P1/P4/P16/PMAX latency, throughput, bytes, CPU, wakeup, and memory measurements.
- [ ] Run clean formatting, clang-tidy, component, process, ASan, and UBSan lanes.
- [ ] Audit that terminal parsing and damage rendering make no steady-state general allocations.
- [ ] Update capability, architecture, protocol, performance, and operational documentation to match
      exactly what shipped.

### Foundational mux completion gate

The foundation is complete when one local daemon can run multiple sessions, tabs, and panes while:

- interactive input has no artificial scheduling delay;
- sustained output retains Lemma's measured latency and byte advantage;
- one blocked or flooded peer cannot materially disrupt unrelated interaction;
- memory scales with live state rather than configured hard maxima;
- idle operation has no rendering wakeups or unexplained CPU use;
- attach transport and all queues are framed or otherwise explicitly bounded;
- visible state recovers after attach, resize, tab change, and lag;
- outer-terminal cleanup and pane-process continuity survive tested client failures;
- all claims are supported by reproducible raw evidence.

Only after this gate should the project decide which deferred user-facing capability to add next.
