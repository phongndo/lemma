# Performance evidence

These are local measurements, not universal rankings. Unless stated otherwise they were collected from release builds on a MacBook Pro Mac16,5 with an Apple M4 Max, 64 GiB RAM, and the pinned toolchain. Raw reports are generated under `build/release/`, which is intentionally untracked; report names are retained here so an archived evidence set can be matched to the claim.

## Reproduction

```sh
just profile=release bench
scripts/ci/benchmarks extended
scripts/ci/regression-budgets     # only valid on the host fingerprint in workloads.json
```

The process harness runs fresh isolated daemons/endpoints, real clients, shell PTYs, terminal parsing, and rendering. A workload ends only when its exact completion marker is visible. Incomplete work is failure, not a latency sample. [`../benchmarks/workloads.json`](../benchmarks/workloads.json) defines workload semantics, versions, sample requirements, units, and host-scoped limits.

Do not run debug, sanitizer, and benchmark Ghostty builds concurrently in one checkout. Diagnostic latency tracing must be compiled and enabled explicitly; ordinary release measurements compile it out.

## Renderer and parser baseline

An 80x24 release microbenchmark on August 9, 2026 measured medians from three clean repetitions:

| Work | CPU per frame | Bytes per frame |
| --- | ---: | ---: |
| Ghostty complete VT formatter | 177.2 us | 39,404 average |
| Styled scrolling damage | 72.5 us | 49 average |
| Detected one-row scroll | 16.8 us | 90 |
| One changed cell span | 3.14 us | 90 |

Large VT parsing measured 1.22 GiB/s. The result supports incremental damage and retained physical-cell state for these workloads; it does not prove that every workload is faster or that further caching is useful.

The warmed steady-state allocation audit performs 10,000 parse/damage/compose/frame-flush iterations after 256 warmups. The retained qualification observed zero C++ general allocations, zero general-allocation bytes, and zero new terminal-quota allocations while flushing 2,150,000 framed bytes.

## Current end-to-end comparison

A thirty-sample same-host comparison after sustained-output remediation used tmux 3.7b, Zellij 0.44.3, the same 80x24 peer, input, and completion markers. Reports are `perf-current-{lemma,tmux,zellij}-comparison-30.json` and `perf-current-comparison-summary.json`.

| Mux | Workload | p50 / p95 | Median outer bytes |
| --- | --- | ---: | ---: |
| Lemma | Warm scroll | 2.694 / 17.276 ms | 402 B |
| tmux | Warm scroll | 145.289 / 150.976 ms | 33,995 B |
| Zellij | Warm scroll | 56.110 / 56.816 ms | 22,377 B |
| Lemma | Attach to visible | 7.247 / 9.187 ms | 1,016 B |
| tmux | Attach to visible | 6.365 / 7.003 ms | 514 B |
| Zellij | Attach to visible | 50.847 / 52.467 ms | 7,985 B |
| Lemma | Interaction under output | 0.449 / 0.764 ms | 620 B |
| tmux | Interaction under output | 0.190 / 0.831 ms | 85 B |
| Zellij | Interaction under output | 12.397 / 13.694 ms | 6,144 B |

Interpretation is workload-specific:

- Lemma had the lowest warm-scroll p50 in this run, but its known approximately 17 ms secondary mode remained visible at p95.
- tmux had the fastest attach p50/p95 and interaction median.
- Lemma had the lower interaction p95 in this distribution, while emitting more bytes than tmux.
- Lemma and tmux recovered the exact 2 MiB blocked-PTY payload; Zellij lost the connection and was recorded as failed.
- Idle tree RSS medians were 8.97/9.95/109.23 MiB for Lemma/tmux/Zellij; wakeup p95 values were 0/2/6 per second.

These observations support only these exact workloads and versions.

## Pane scaling and sustained output

Two final thirty-sample reports, `perf-final-event-peer-profiles-30.json` and its repeat, measured 1, 4, 16, and 64 panes. The table uses the larger statistic from the pair rather than selecting the faster run.

| Active profile | Tree CPU p95 / s | Daemon CPU p95 / s | Wakeups p95 / s | Outer B/s p50 | Key-to-visible p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 pane | 1.007 ms | 0.630 ms | 953 | 9,009 | 0.337 / 0.744 ms |
| 4 panes | 0.891 ms | 0.506 ms | 943 | 9,765 | 0.216 / 0.479 ms |
| 16 panes | 1.086 ms | 0.708 ms | 947 | 9,765 | 0.256 / 0.465 ms |
| 64 panes | 1.934 ms | 1.526 ms | 1,030 | 9,765 | 0.215 / 0.886 ms |

The same-host tmux active tree-CPU p95 values were 1.715, 1.971, 2.213, and 3.224 ms for the same pane counts. This is a resource result, not a general latency or feature-parity claim.

The measured sustained-output improvements came from three independently retained changes:

1. autonomous output begins at a 2 ms deadline and moves to a 16 ms cadence after 50 ms of continuous output with gaps no greater than 10 ms;
2. unchanged separators render only on full/layout redraws; and
3. foreground-process title discovery is limited to once per 100 ms per output-active pane.

Across staged ten-sample reports, those changes reduced active outer bytes from roughly 63–536 KiB/s to roughly 9–10 KiB/s and active tree CPU p95 to 0.9–1.9 ms, without changing interactive/state-change urgency.

## Isolation evidence

A raw 500x200 non-reading client with a 4 KiB requested receive buffer was attached while its pane produced an unbounded flood. Another session completed exact-token interactions. Retained runs disconnected the non-reader after 5.016 seconds in the original qualification and 5.026/5.029 seconds in later thirty-interaction runs, within the 5-second no-progress deadline plus observation allowance.

Current policy bounds one client to 64 KiB/32 writes per turn and all attached clients to 256 KiB per turn. A blocked session receives a 4 KiB PTY-read isolation slice while retaining canonical progress. New presentation damage stays in Ghostty and repairs with one full redraw after the old transaction drains.

## Host-theme projection qualification

A ten-sample release `attach-visible` run after the private-protocol 2.0 epoch and accepted-attachment host-theme query ordering measured 6.361 ms p50, 6.823 ms p95, and 1,197 median client bytes on the documented M4 Max host. The client starts the query only after the daemon accepts the attachment and does not await replies before rendering, so its 100 ms collection deadline remains outside the attach-to-visible critical path.

Focused release renderer medians were 128.023 µs for ANSI damage frames, 3.702 µs for one changed row, and 62.745 µs for detected scroll operations. Reproduce with:

```sh
python3 benchmarks/mux_benchmark.py --mode attach-visible --multiplexer lemma \
  --repetitions 10 --server build/release/lemma_test_server \
  --cli build/release/lemma_test_cli --peer build/release/lemma_test_pty_peer

./build/release/lemma_benchmarks \
  --benchmark_filter='benchmark_terminal_ansi_(damage_frames|single_row|scroll_operations)' \
  --benchmark_repetitions=5 --benchmark_report_aggregates_only=true --benchmark_min_time=0.05s
```

## Known measured caveats

- Attach-to-visible remains above the older host-scoped 4.7/5.4 ms p50/p95 limits. Replacing a one-millisecond emergency-restorer polling loop with descriptor polling improved paired attach p50/p95 by 12.7%/9.6%, but later complete runs still measured 6–9 ms tails.
- Idle key-to-visible p95 occasionally crosses the 0.5 ms host-scoped profile limit at one or 64 panes while medians and idle CPU remain low. Passing retries are not used to erase those tails.
- The approximately 17–20 ms warm-scroll secondary mode has appeared across multiple distributions and remains visible in the current comparison.
- Shared CI timing and reports from a nonmatching host identity cannot satisfy the pinned-host regression gate.

No threshold should be widened merely to turn these observations green. A changed threshold requires a new retained distribution and explicit review.

## Trace evidence

The opt-in trace stores at most 32,768 fixed 40-byte events in a 1,310,784-byte mmap file per daemon/client. Overflow keeps the bounded prefix and increments a drop count. Trace correlation uses exact input tokens across client read, daemon decode, PTY write, matching PTY output, composition, socket progress, client receipt, and outer write.

After the interactive scheduler change, 200 isolated idle/blocked inputs produced complete exact-token paths with zero rejections and drops. Physical input to outer-write completion changed from 2.580/2.764/3.172 ms to 0.180/0.226/0.244 ms p50/p95/p99. The removed interval was the approximately 2.3 ms wait between echoed PTY output and composition start; the trace demonstrated that the cost was removed rather than shifted.

Trace-enabled measurements are diagnostic and are never silently mixed with compiled-out release baselines.
