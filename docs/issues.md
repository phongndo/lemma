# Issues

This is the evidence-derived problem list from the F5 foundational mux audit that began at HEAD
`b92d0aa`. It is an audit snapshot, not a second execution backlog: [`../TODO.md`](../TODO.md) owns
priority and completion state, while [`performance.md`](performance.md) owns the complete measurements
and methodology. A qualification blocker below is not automatically a confirmed product defect;
several findings still need paired reproduction on the approved host.

No threshold, timeout, or scope check may be widened merely to close an item.

## F5-001 — Idle visible-latency tails exceed the frozen profile budgets

**Class:** observed performance failure; foundational gate blocker

The 30-sample profile report exceeded the idle key-to-visible limits in two conditions:

- P1 p95 was **1.335 ms** against a **0.500 ms** maximum.
- P16 p50 was **0.274 ms** against a **0.250 ms** maximum.

P4 and PMAX idle latency passed, and every idle CPU and profile RSS limit passed.

**Evidence:** `build/release/f5-pane-profiles-30.json`

**Resolution evidence required:** paired 30-or-more-sample runs on the reviewed benchmark host that
identify code versus host variance, followed by a code fix if reproducible and a passing unchanged
budget evaluation.

## F5-002 — Active latency fails at low pane counts and has large high-pane tails

**Class:** observed performance failure; foundational gate blocker

Against the active **1.600 ms p50 / 1.800 ms p95** key-to-visible limits:

- P1 measured **2.510 / 2.790 ms**.
- P4 measured **1.734 / 1.852 ms**.
- P16 measured a passing **1.599 ms p50** but a failing **21.701 ms p95**; key-to-PTY p95 was also
  **17.544 ms** against its **1.600 ms** maximum.
- PMAX measured a passing **1.527 ms p50** but a failing **19.945 ms p95**; key-to-PTY p95 was also
  **16.330 ms** against its **1.600 ms** maximum.

The P16/PMAX split between passing medians and very large tails suggests a tail-latency problem, but
F5 has not yet established whether its source is scheduler behavior, host interference, or mux code.

**Evidence:** `build/release/f5-pane-profiles-30.json`

**Resolution evidence required:** correlate delayed input, PTY progress, composition, frame flush, and
host scheduling without enabling diagnostic work in production measurements; then pass the existing
latency limits on the reviewed host.

## F5-003 — Every active pane profile exceeds the CPU budget

**Class:** observed resource failure; foundational gate blocker

The active process-tree CPU p95 limit is **5.000 ms per one-second sample**. Measurements were:

- P1: **13.922 ms**
- P4: **17.554 ms**
- P16: **18.001 ms**
- PMAX: **18.175 ms**

Idle CPU and every profile RSS limit passed. The measurements therefore show active overhead rather
than an idle spin or a profile-memory budget failure.

**Evidence:** `build/release/f5-pane-profiles-30.json`

**Resolution evidence required:** attribute CPU by daemon/client/pane role, remove reproducible mux
overhead, and pass the unchanged active CPU limit in a valid pinned-host report.

## F5-004 — A blocked-client deadline failure was observed but not reproducibly retained

**Class:** intermittent reliability observation plus evidence defect; foundational gate blocker

A full process run was observed to exceed the unchanged **5-second no-progress deadline plus
0.5-second observation allowance** and abort. The original command captured only stdout; its empty
`f5-mux-all.log` artifact was discarded, so that observation is not sufficient retained proof of a
Lemma defect. Meanwhile, two isolated release stress repetitions passed with a maximum disconnect of
**5.272 seconds**.

**Evidence:** passing runs are in `build/release/f5-release-blocked-client-smoke-*.json` and
`build/release/f5-release-blocked-client-smoke-summary.json`; the failed case still requires a usable
JSON reproduction. The checked-in F5 driver now requests failure JSON instead of accepting a partial
or empty report.

**Resolution evidence required:** repeatedly reproduce under controlled load with timestamps for
frame progress, deadline arming, disconnect, and observer scheduling. If the server violates the
bound, fix it; if only the observer was delayed, retain paired host-scheduling evidence. In either
case, the complete repeated workload must pass without widening the bound.

## F5-005 — The benchmark host no longer satisfies the pinned identity

**Class:** evidence-scope failure; foundational gate blocker

The reviewed manifest names `Phongs-MacBook-Pro.local`, while the same physical Mac16,5 currently
reports `Mac-2497`. Model and hardware similarity do not satisfy an exact host-identity check, so the
current raw measurements cannot produce a formally valid pinned-host gate.

**Evidence:** host metadata in `build/release/f5-pane-profiles-30.json` and the approved identity in
`benchmarks/workloads.json`.

**Resolution evidence required:** run on the reviewed identity, or deliberately review and record a
new dedicated-host distribution and manifest identity. Do not bypass or silently loosen scope
validation.

## F5-006 — No successful aggregate finite F5 result exists

**Class:** missing qualification evidence; foundational gate blocker

Individual release, compatibility, allocation, lifecycle, quality, sanitizer, short-soak, and smoke
stress evidence passed. However, no single `scripts/ci/f5 extended` invocation has completed all
20-repetition release/sanitizer stress, complete process/profile reports, 1,000 lifecycle cycles, and
an unchanged-budget evaluation with exit status zero.

**Resolution evidence required:** retain one complete passing `build/release/f5-*` artifact set from:

```sh
nix develop --command scripts/ci/f5 extended
```

## F5-007 — The required 24-hour optimized release soak is absent

**Class:** durability evidence gap; foundational gate blocker

The ten-second release run only qualifies the harness. It cannot establish day-scale RSS, descriptor,
process, wakeup, CPU, detach/reattach, or terminal-restoration behavior.

**Resolution evidence required:** run

```sh
nix develop --command scripts/ci/f5-soak release 86400 300
```

and retain a `completed` report with requested and elapsed workload duration of at least 86,400
seconds, correct interactions/restoration, and no unexplained resource trend.

## F5-008 — The required 24-hour ASan/UBSan soak is absent

**Class:** sanitizer durability evidence gap; foundational gate blocker

The ten-second sanitizer run qualifies process startup and the workload but is not long-soak evidence.
Apple's ASan runtime does not implement LeakSanitizer, so its absence must remain explicit; the run
still must be clean under the available ASan/UBSan instrumentation.

**Resolution evidence required:** run

```sh
nix develop --command scripts/ci/f5-soak sanitizers 86400 300
```

and retain a `completed` 86,400-second report with no sanitizer finding, correctness failure,
terminal-restoration failure, descriptor leak, or unexplained resource trend.

## What F5 did not show as a problem

The retained evidence did **not** find:

- a steady-state allocation in the audited parse/damage/compose/frame-flush path;
- process, descriptor, terminal-state, or final-window RSS leakage over 1,000 lifecycle cycles;
- a release or ASan/UBSan functional-test failure;
- a compatibility failure in bash, zsh, fish, Neovim, Vim, less, Python, or htop;
- a profile RSS budget failure; or
- a reason to weaken an F0–F4 limit.

These passing observations are bounded by their recorded workloads and durations; they are not a
substitute for the missing aggregate and 24-hour evidence.
