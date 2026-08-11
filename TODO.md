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
11. Prefer stack/automatic storage for small, compile-time-bounded, non-escaping scratch state. Large
    or persistent state requires one explicit RAII owner; do not move multi-megabyte or long-lived
    buffers onto the stack merely to avoid the heap.
12. General-purpose capacity growth belongs at reviewed control-plane lifecycle boundaries, never
    in steady-state render or flush work. Any unavoidable content-proportional PTY history growth
    must use an owner-scoped quota. Expose owned storage to leaf operations as non-owning spans.

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

- [x] Remove `send()` from `src/render/single_pane.cpp`; make composition only fill retained bounded
      frame state.
- [x] Move attached-client writes behind a core-owned bounded flush operation with injectable unit-test
      writers, matching the PTY and pending-control output patterns.
- [x] Add a daemon-wide attached-client write budget and a round-robin cursor so session iteration
      order cannot dominate progress.
- [x] Record output progress time and disconnect a client that exceeds a reviewed no-progress or total
      frame deadline.
- [x] Preserve one retained frame per attached client; accumulate later changes as canonical terminal
      damage and repair with a complete redraw when required.
- [x] Measure whether draining every ready PTY before client input harms loaded p95/p99 latency.
- [x] If measured, introduce a bounded latency lane that first drains output required for the focused
      pane's terminal-response ordering, handles client input, and then round-robins bulk PTY work. The
      direct blocked-client/flood distribution improved, so this conditional lane was not introduced.
- [x] Preserve the 256 KiB global PTY-read bound and per-pane/global PTY-write bounds unless a benchmark
      and isolation test justify a reviewed change.
- [x] Add blocked-client, many-writable-client, flooded-pane, and session-order fairness tests.

### F2 completion gate

- A blocked attached client has bounded memory, CPU, and lifetime.
- No socket write occurs in the render subsystem.
- A flooded or blocked session increases unrelated key-to-visible p95 by less than 10% on the pinned
  workload, or a stricter evidence-based budget.
- Every ready class makes bounded progress without descriptor-order starvation.
- Warm-scroll and sparse-frame advantages remain intact.

F2 completed with one 4 MiB-bounded retained frame per attached client, 64 KiB per-client and
256 KiB daemon-wide write limits per reactor turn, a persistent round-robin cursor, and 5 s
no-progress/30 s total-frame deadlines. Damage behind a retained frame collapses into one forced full
redraw after drain; no renderer source performs socket I/O. Deterministic tests cover partial writes,
EINTR/EAGAIN, blocked and flooded clients, recovery, deadlines, many clients, global/per-client
budgets, and low-slot starvation. The new pinned-host non-reader plus unbounded pane-flood workload
disconnected at 5.016 s while unrelated key-to-visible improved from 0.203/0.288/0.294 ms to
0.147/0.159/0.168 ms p50/p95/p99. Its reviewed p95 loaded/idle ratio gate is 1.10; the final observed
ratio was 0.552. The final 80-check release gate passed without widening any F0/F1 limit; raw report
names and the complete accounting are in `docs/performance.md`.

## F3: reduce baseline and marginal memory

Apply a TigerStyle-inspired memory discipline, adapted to a dynamic local mux rather than copying
TigerBeetle's allocate-everything-at-startup rule literally. Prioritize safety, then performance,
then developer experience. Put a checked limit on every memory owner and prefer this storage order:

1. small, bounded, non-escaping scratch state in stack/automatic storage;
2. small fixed-capacity state inline with its lifetime owner when the census justifies the eager cost;
3. bounded startup-owned pools for resources shared across many short-lived operations;
4. large or variable storage in one RAII owner, sized only at an explicit control-plane boundary such
   as startup, connection setup, create, attach, or resize, then reused without data-plane allocation;
   content-proportional terminal history is the reviewed exception and must remain quota-owned.

Stack-first is not stack-only. Large retained frames, scrollback, and other state that outlives a call
must not become large stack locals. New F3 paths must avoid recursion, document a bounded stack
high-water estimate, and use `std::span` or another non-owning view below the owner. Do not introduce
naked `new`/`delete`, default shared ownership, or a general allocator framework without measured
need.

For every material allocation, record its owner, lifetime, minimum/current/maximum bytes, allocation
and release points, failure behavior, whether pages are touched eagerly, and whether allocator work
can occur on a reactor data path. Capacity changes must use checked arithmetic, prepare replacement
storage before mutation, and commit only after success so failure leaves the old state valid. Pair
runtime assertions across producer/consumer boundaries and use compile-time assertions for limit and
type-size relationships.

Measure memory as:

```text
M(N, H) = M_base + N * M_pane + M_history(H) + M_fragmentation
```

Do not count configured hard maxima as acceptable resident cost.

- [x] Produce a byte-level ownership census for daemon baseline, session, tab, pane, terminal,
      scrollback, decoder, frame, PTY queue, pending connection, and extension-host state, including
      storage class, lifetime, eager/lazy page use, stack contribution, and allocation call site.
- [x] Replace the 64 KiB eager output array in every pending-connection slot with lazy storage or a
      bounded shared pool; preserve aggregate and per-connection limits.
- [x] Allocate frame storage only for attached sessions and release it on detach when evidence shows
      that doing so improves resident memory without attach churn or fragmentation regressions.
- [x] Replace the eager 4 MiB frame allocation with bounded viewport-derived capacity that grows only
      on attach/resize and performs no steady-state render allocation.
- [x] Verify that PTY write queues and Ghostty scrollback grow lazily and remain under daemon-wide and
      per-pane bounds.
- [x] Measure allocator retention and fragmentation after repeated create/split/close/attach/detach
      cycles.
- [x] Record stripped executable sizes and dependency/process contributions; make the extension host
      lazy or absent from the foundational path if it contributes idle cost without configuration.
- [x] Add deterministic allocation-boundary tests: rejected capacity calculations, failed lifecycle
      growth with old-state preservation, no allocator calls in steady-state composition/flush, and
      compile-time size/limit assertions for new scratch storage.

Implement F3 evidence-first: capture the census and P1/P4/P16/PMAX baseline, rank owners by measured
resident cost, change one dominant owner at a time, and rerun correctness, latency, bytes, CPU, and
memory evidence after each change. Do not optimize an owner merely because its configured maximum is
large.

### F3 completion gate

- Baseline and marginal pane/session/history costs are documented and covered by process tests.
- No data structure eagerly allocates proportional to daemon hard maxima unless required by measured
  hot-path performance and explicitly justified.
- Target P1 idle process-tree RSS at no more than 1.5x pinned tmux under identical completion
  semantics. If this is not achievable, stop and review the measured irreducible owner rather than
  weakening or hiding the metric.
- Repeated lifecycle and output workloads return to a stable memory plateau.
- Rendering and attached-client flushing remain allocation-free after attach/resize capacity is
  established; PTY queue/history growth occurs only through documented owner quotas and reuses
  existing capacity whenever sufficient.
- Stack high-water use for new F3 paths is documented and safely bounded; no large persistent buffer
  is disguised as a stack allocation.
- Every lifecycle allocation has one RAII owner, a checked maximum, a deterministic failure path, and
  tests that preserve the previous valid state on failure.

F3 completed evidence-first on the pinned host. The initial compiler census ranked the eagerly
materialized pending-connection table (17,318,912 bytes) and one eager 4 MiB frame per session as the
dominant owners. Isolated P1 daemon reruns fell from 24,952,832 to 7,716,864 bytes after lazy pending
slots, then to 3,719,168 bytes after attached-only viewport frames. Final P1 idle process-tree RSS was
7.70 MiB versus tmux's 10.00 MiB (0.770x), down from 28.30 MiB. One hundred complete lifecycle cycles
reached a stable 4,800,512-byte daemon plateau at cycle 67 and stayed there for the final 34 cycles.
Rendering and attached flush have deterministic no-growth coverage; failed frame growth preserves the
old frame; PTY queues reuse quota-owned capacity; scrollback remains terminal-quota-owned; and an
unconfigured foundational daemon has no extension runtime or host process. The final unchanged
80-check F0-F2 release gate passed after two retained profile failures and a clean retry, then passed
again in the retained post-review run; no limit was widened. Reproduction, raw report names, byte
owners, stack high-water, binary sizes, and performance
comparisons are in `docs/memory.md` and `docs/performance.md`.

## F4: bound and version the private attach path

Implement only the private protocol needed by the foundational mux. Do not introduce a public RPC or
semantic automation system.

- [x] Replace `lemma-v9` with one versioned, bidirectionally framed protocol.
- [x] Limit the message set to hello/version, input, resize, pane command, detach, complete render
      frame, full-redraw generation, and typed error/disconnect reason.
- [x] Validate every type, length, enum, dimension, sequence, and version before mutation.
- [x] Add bounded incremental decoders to both daemon and client.
- [x] Preserve partial-read/write behavior and the output progress policy from F2.
- [x] Reject incompatible peers with an actionable diagnostic and no partial attach.
- [x] Add golden, fragmented, coalesced, malformed, oversized, mismatch, partial-write, blocked-peer,
      reconnect, and full-redraw recovery tests.
- [x] Make attached-client terminal restoration reliable on normal exit, startup failure, daemon loss,
      EOF, and every handled signal.
- [x] Re-run all performance suites and account for framing overhead explicitly.

### F4 completion gate

- Both directions are bounded and framed; daemon ANSI is never an ambiguous socket byte stream.
- Attach, resize, tab switch, reconnect, and lag repair reconstruct complete visible state.
- Incompatible and malicious local peers have bounded impact and precise outcomes.
- Framing causes no material interactive-latency regression and no more than 5% byte/CPU regression
  outside measured variance.
- Outer-terminal modes are restored on every tested exit path.

F4 completed with private protocol 1.0 on `lemma-private-1.0`. Its deterministic 16-byte envelope,
closed kinds, bounded incremental decoders, render generations, typed disconnects, validation-before-
mutation, and terminal cleanup are covered by codec, fragmentation, malformed-peer, recovery, and
signal tests. The final trace measured exactly 20 framing bytes per render frame and 4.48% aggregate
wire overhead. Extended benchmarks and memory/lifecycle suites completed; raw `f4-*` evidence is
retained in `build/release`. The unchanged absolute latency gate could not pass in the host's slower
scheduling mode, including at the pinned parent; paired same-host evidence found active CPU medians
within 1.3%, same-pane visible p50 within 0.3% and p95 +4.62%, unchanged outer bytes, and improved
blocked-client isolation. No budget was widened; the failed absolute reports are retained and
explained in `docs/performance.md`.

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
