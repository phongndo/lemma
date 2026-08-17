# Performance evidence

These are local measurements, not universal rankings. Unless stated otherwise they were collected from release builds on a MacBook Pro Mac16,5 with an Apple M4 Max, 64 GiB RAM, and the pinned toolchain. Raw reports are generated under `build/release/`, which is intentionally untracked; report names are retained here so an archived evidence set can be matched to the claim.

## Reproduction

```sh
just profile=release bench
nix develop .#benchmarks --command scripts/ci/benchmarks extended
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

A post-change five-repetition release microbenchmark populated 20,000 rows, held the Ghostty viewport 100 rows above the live area, alternated normalized one-row wheel movement, and forced the same complete pane redraw required by server-rendered viewport navigation. Median CPU was 46.991 us per event with 2,304 output bytes. This measures one 80x23 terminal projection, not split-pane composition or outer-device pixel scrolling. Reproduce with:

```sh
./build/release/lemma_benchmarks \
  --benchmark_filter='^benchmark_terminal_viewport_wheel_frames$' \
  --benchmark_min_time=0.2s --benchmark_repetitions=5 \
  --benchmark_report_aggregates_only=true
```

A separate thirty-sample `interactive-output` release run after adding the application-input viewport reset measured key-to-PTY p50/p95/p99 of 0.092/0.122/0.131 ms and key-to-visible of 0.343/0.481/0.517 ms. Compared with the retained 0.101/0.187 ms and 0.759/1.119 ms p50/p95 baseline below, the canonical viewport-active query did not regress this workload. The report is `scrollback-native-interactive-output-30.json`.

The warmed steady-state allocation audit performs 10,000 parse/damage/compose/frame-flush iterations and 10,000 alternating terminal resizes after 256 warmups. The retained qualification observed zero C++ general allocations, zero general-allocation bytes, and zero new terminal-quota allocations while flushing 2,180,000 framed bytes. Physical-cell hash storage grows transactionally with bounded geometric headroom and reuses that capacity across live resize instead of allocating an exact replacement for every pane and pointer-cell movement.

A same-process qualification on August 16, 2026 measured the composed-render effect of separating Lemma's outer mouse capture policy from child mouse modes. Five one-second release repetitions before and after the change retained identical average frame sizes and produced these CPU medians:

| Panes | Before | After | Frame bytes before/after |
| ---: | ---: | ---: | ---: |
| 1 | 6.435 us | 6.163 us | 165 / 165 |
| 4 | 13.318 us | 12.943 us | 216 / 216 |
| 16 | 28.873 us | 28.132 us | 422 / 422 |
| 64 | 68.623 us | 67.289 us | 1,254 / 1,254 |

This shows no measured composition or output-size regression for the changed per-frame mode projection; it is not an end-to-end mouse-latency result. Reproduce with:

```sh
./build/release/lemma_benchmarks \
  --benchmark_filter='^benchmark_terminal_multiple_panes/(1|4|16|64)$' \
  --benchmark_min_time=1s --benchmark_repetitions=5 \
  --benchmark_report_aggregates_only=true
```

## Split-layout projection

A three-repetition release microbenchmark on August 17, 2026 measured the allocation-free fixed-point layout paths. Median CPU was 59.0/84.0/183/590 ns for 1/4/16/64-pane balanced projection. Copying and keyboard-resizing a 64-pane candidate layout, including before/after projection and invariant-preserving ratio update, measured 1.542 us median. Exact projected-divider hit-testing at mouse press measured 618 ns. A later five-repetition measurement of one captured-divider candidate resize plus exact divider-rectangle projection measured 2.108 us median. Each distinct mouse-cell position performs that bounded candidate calculation and commits real layout/Ghostty geometry for live rendering. Child PTY resize notifications are a separate fixed-state coalescer: the first position is immediate, later positions replace one latest endpoint behind a 250-ms gate, and release forces exact convergence. A separate five-repetition maximum-depth 64-pane layout measured 1.153 us projection and 1.226 us to hit its deepest divider, bounding the deliberately adversarial tree shape rather than only the balanced case. This is semantic layout work only; it excludes Ghostty reflow, coalesced PTY `TIOCSWINSZ`, frame composition, and client transport, so it establishes bounded Core cost rather than end-to-end live-resize latency.

```sh
./build/release/lemma_benchmarks \
  --benchmark_filter='^benchmark_layout_(projection|resize_candidate|divider_hit|divider_resize_candidate)' \
  --benchmark_min_time=0.05s --benchmark_repetitions=3 \
  --benchmark_report_aggregates_only=true
```

A five-repetition live-divider microbenchmark alternated one root separator cell and included candidate layout publication, every changed Ghostty terminal resize, and complete pane composition. Median CPU was 482.899/500.827/536.456/631.575 us for 2/4/16/64 panes, with average frames of 21,196/20,941/22,216/24,586 bytes. It excludes PTY ioctls, child scheduling, socket transport, and the outer terminal, so it bounds daemon-owned live reflow/composition rather than claiming pointer-to-screen latency. Reproduce with:

```sh
./build/release/lemma_benchmarks \
  --benchmark_filter='^benchmark_live_divider_resize/' \
  --benchmark_min_time=0.1s --benchmark_repetitions=5 \
  --benchmark_report_aggregates_only=true
```

The daemon applies at most 16 decoded client messages and one geometry-bearing message per session per reactor turn. Valid retained packets resume on the next turn; this bounds one peer's resize work without dropping or reordering reports.

A real-PTY integration qualification delivered eight distinct outer sizes 10 ms apart. The attached client settled at the final size and the child shell's `WINCH` trap observed exactly one signal. A separate long divider drag observed the immediate, periodic, and exact release endpoints as three child notifications while returning to its starting geometry. These are deterministic gesture/coalescing checks rather than latency benchmarks; subsequent user input forces a pending outer endpoint immediately so input does not overtake known pending geometry.

## Current end-to-end comparison

A thirty-sample same-host comparison used tmux 3.7b, Zellij 0.44.3, Herdr 0.8.0, and Lemma at `f1e4fc3`. All subjects received the same 80x24 peer, input, and exact completion conditions. The autonomous-output peer pauses for 50 ms during untimed setup so delayed renderers can expose readiness before load begins. Herdr used its normal tab row but hid the sidebar and pane scrollbar, giving the root pane the same 80x23 area as Lemma and tmux; update checks and restart history were disabled.

Reports are `perf-current4-{lemma,tmux,zellij,herdr}-comparison-30.json`, the dedicated failed-backpressure reports, and `perf-current4-summary.json`.

| Mux | Workload | p50 / p95 | Median outer bytes |
| --- | --- | ---: | ---: |
| Lemma | Warm scroll | 2.636 / 19.081 ms | 567 B |
| tmux | Warm scroll | 149.423 / 151.802 ms | 33,941 B |
| Zellij | Warm scroll | 46.389 / 47.403 ms | 20,412 B |
| Herdr | Warm scroll | 713.281 / 2,123.898 ms | 1,918 B |
| Lemma | Attach to visible | 6.322 / 7.070 ms | 1,235 B |
| tmux | Attach to visible | 5.142 / 5.520 ms | 514 B |
| Zellij | Attach to visible | 47.592 / 48.704 ms | 7,985 B |
| Herdr | Attach to visible | 42.142 / 52.246 ms | 5,980 B |
| Lemma | Interaction under output | 0.759 / 1.119 ms | 633 B |
| tmux | Interaction under output | 0.200 / 0.547 ms | 32 B |
| Zellij | Interaction under output | 15.633 / 17.913 ms | 6,144 B |
| Herdr | Interaction under output | 2.153 / 19.314 ms | 87 B |

Interaction key-to-PTY p50/p95 was 0.101/0.187 ms for Lemma, 0.119/0.289 ms for tmux, 0.137/0.331 ms for Zellij, and 0.668/0.867 ms for Herdr. Idle tree RSS medians were 9.281/10.203/110.344/32.297 MiB in the same order. Idle tree CPU p95 per second was 0/0.020/0.006/0.068 ms. Wakeup p95 was 0/1/4 for Lemma/tmux/Zellij; Herdr's complete-tree wakeup counter was unavailable because its shell could not be sampled, while its daemon and client separately measured 14 and 30 wakeups/s p95.

The blocked-PTY test applies 2 MiB of client input to one session, verifies the exact count and digest, and measures another session before and during backpressure:

| Mux | Bytes accepted before stall | Completion | Other-session key-to-visible p50 / p95 |
| --- | ---: | --- | ---: |
| Lemma | 1,125,222 | Exact 2 MiB recovered | 0.685 / 0.874 ms |
| tmux | 2,097,152 | Exact 2 MiB recovered | 0.224 / 0.241 ms |
| Zellij | 448,658 | Client lost its server connection | 15.468 / 15.689 ms |
| Herdr | 471,142 | Peer received 2,061,556 B; 35,596 B missing | 2.436 / 12.208 ms |

### Retained Lemma result detail

The Lemma rows above come from `perf-current4-lemma-comparison-30.json`. This table records the complete retained statistics without mixing in trace-enabled diagnostics:

| Workload | Samples / completion | Retained measurements |
| --- | --- | --- |
| Warm scroll | 30 / completed | key-to-marker p50/p95/p99 2.636/19.081/19.150 ms; 27 samples at or below 3 ms and three above 10 ms at 16.880/19.081/19.150 ms; 567 outer bytes median |
| Attach to visible | 30 / completed | p50/p95/p99 6.322/7.070/7.145 ms; 1,235 outer bytes median |
| Interaction under output | 30 / completed | key-to-PTY p50/p95/p99 0.101/0.187/0.200 ms; key-to-visible 0.759/1.119/1.125 ms; 633 outer bytes median |
| Idle resources | 30 one-second intervals / completed | tree RSS 9.281 MiB: daemon 3.375 MiB, attached client 1.891 MiB, child tree 4.016 MiB; tree CPU p95 0 ms/s; wakeups p95 0/s |
| Blocked PTY | 30 interactions before and during backpressure / completed | 1,125,222 B accepted before client backpressure; exact 2,097,152-B payload completed; other-session key-to-visible p50/p95/p99 0.685/0.874/1.234 ms |
| Blocked client | 30 interactions before and during backpressure / completed | non-reading 4-KiB receive-buffer client detached after 5.015 s; other-session key-to-visible p50/p95/p99 0.351/0.374/0.411 ms |

Interpretation is workload-specific:

- Lemma had the fastest warm-scroll distribution. Its three samples above 10 ms remain a real secondary mode, but Herdr exceeded 500 ms in 17 of 30 samples and had a 713 ms median.
- tmux led attach and interaction p50/p95 and was the only subject whose blocked input fit without harness-observed backpressure.
- Lemma was second to tmux for interactive latency and was the only other subject to recover the exact blocked payload.
- Herdr emitted nearly as few controlled-interaction bytes as tmux, but its delayed high-scroll and interaction distributions show why low emitted-byte counts alone are not an efficiency result.
- Zellij and Herdr both failed the exact blocked-input completion contract in different ways; responsiveness of the other session did not make the incomplete primary work a successful sample.

These observations support only these exact workloads, versions, host, and configuration.

## Pane scaling and sustained output

Two final thirty-sample reports, `perf-final-event-peer-profiles-30.json` and its repeat, measured 1, 4, 16, and 64 panes. The table uses the larger statistic from the pair rather than selecting the faster run.

| Active profile | Tree CPU p95 / s | Daemon CPU p95 / s | Wakeups p95 / s | Outer B/s p50 | Key-to-visible p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 pane | 1.007 ms | 0.630 ms | 953 | 9,009 | 0.337 / 0.744 ms |
| 4 panes | 0.891 ms | 0.506 ms | 943 | 9,765 | 0.216 / 0.479 ms |
| 16 panes | 1.086 ms | 0.708 ms | 947 | 9,765 | 0.256 / 0.465 ms |
| 64 panes | 1.934 ms | 1.526 ms | 1,030 | 9,765 | 0.215 / 0.886 ms |

The same-host tmux active tree-CPU p95 values were 1.715, 1.971, 2.213, and 3.224 ms for the same pane counts. Herdr's `perf-current4-herdr-pane-profiles-30.json` produced:

| Herdr active profile | Tree RSS p50 | Tree CPU p95 / s | Wakeups p95 / s | Key-to-visible p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 pane | 44.88 MiB | 24.664 ms | 905 | 22.386 / 27.634 ms |
| 4 panes | 56.33 MiB | 20.562 ms | 909 | 21.534 / 23.010 ms |
| 16 panes | 100.14 MiB | 20.477 ms | 940 | 16.295 / 24.251 ms |
| 64 panes | 274.83 MiB | 20.874 ms | 1,012 | 18.008 / 25.884 ms |

Herdr's active outer-byte median was zero in every profile, with sparse nonzero samples. Coupled with its visible-latency and warm-scroll results, this indicates delayed or coalesced presentation rather than free sustained-output throughput. These are resource results, not a general feature-parity claim.

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

Focused release renderer medians were 128.023 µs for ANSI damage frames, 3.702 µs for one changed row, and 62.745 µs for detected scroll operations.

A later three-run, thirty-sample release qualification pre-armed the emergency terminal restorer before raw-mode mutation and removed its synchronous startup acknowledgement. The guardian inherits one validated control description and opens its redundant fallback independently while attach proceeds. Using the larger statistic from `investigate-attach-lemma-prearmed-async-open-30.json`, its repeat, and `investigate-attach-lemma-final-30.json`, attach-to-visible measured 5.214/5.549/5.905 ms p50/p95/p99 with 1,235 median outer bytes. The same-host `investigate-attach-tmux-post-30.json` measured 5.114/5.516/5.729 ms. The earlier Lemma investigation baseline was 6.944/8.263/11.289 ms, so the retained mechanism removed 24.9% of p50 and 32.9% of p95 without changing daemon rendering or the outer-byte bound.

Reproduce with:

```sh
python3 benchmarks/mux_benchmark.py --mode attach-visible --multiplexer lemma \
  --repetitions 10 --server build/release/lemma_test_server \
  --cli build/release/lemma_test_cli --peer build/release/lemma_test_pty_peer

./build/release/lemma_benchmarks \
  --benchmark_filter='benchmark_terminal_ansi_(damage_frames|single_row|scroll_operations)' \
  --benchmark_repetitions=5 --benchmark_report_aggregates_only=true --benchmark_min_time=0.05s
```

## Known measured caveats

- Attach-to-visible remains slightly above the older host-scoped 4.7/5.4 ms p50/p95 limits. Pre-arming the emergency restorer removed the previous 6–9 ms distribution on the qualified runs, but the larger retained 5.214/5.549 ms p50/p95 still does not satisfy those historical limits.
- Idle key-to-visible p95 occasionally crosses the 0.5 ms host-scoped profile limit at one or 64 panes while medians and idle CPU remain low. Passing retries are not used to erase those tails.
- The approximately 17–20 ms Lemma warm-scroll secondary mode has appeared across multiple distributions and remains visible in the current comparison.
- Herdr's current high-scroll distribution is strongly multimodal, its active interaction p95 remains near one render cadence or worse, and attach had one 277.935 ms p99/max sample. Low wire-byte totals must not be treated as a win until exact completion and visible freshness are demonstrated.
- Herdr and Zellij fail the current 2 MiB blocked-input completion test. This is a correctness and isolation result, not merely a slower latency sample.
- Shared CI timing and reports from a nonmatching host identity cannot satisfy the pinned-host regression gate.

No threshold should be widened merely to turn these observations green. A changed threshold requires a new retained distribution and explicit review.

## Trace evidence

The opt-in trace stores at most 32,768 fixed 40-byte events in a 1,310,784-byte mmap file per daemon/client. Overflow keeps the bounded prefix and increments a drop count. Trace correlation uses exact input tokens across client read, daemon decode, PTY write, matching PTY output, composition, socket progress, client receipt, and outer write.

After the interactive scheduler change, 200 isolated idle/blocked inputs produced complete exact-token paths with zero rejections and drops. Physical input to outer-write completion changed from 2.580/2.764/3.172 ms to 0.180/0.226/0.244 ms p50/p95/p99. The removed interval was the approximately 2.3 ms wait between echoed PTY output and composition start; the trace demonstrated that the cost was removed rather than shifted.

A later trace-enabled 100-interaction active-output diagnostic repaired the client receive correlation gap without timestamp matching. Each successful socket read reserves one append-only trace event at read time; the decoder assigns that event's correlation once only when the exact marker-bearing frame becomes complete. `perf-trace-correlation-fixed-100-analysis.json` retained 100/100 complete paths with zero rejected paths and zero dropped events:

| Stage from physical input | p50 / p95 / p99 |
| --- | ---: |
| Daemon message decode | 0.036 / 0.074 / 0.080 ms |
| PTY write progress | 0.047 / 0.096 / 0.103 ms |
| Matching PTY output | 0.080 / 0.138 / 0.172 ms |
| Composition start | 0.097 / 0.206 / 0.234 ms |
| Composition finish | 0.220 / 0.380 / 0.457 ms |
| Daemon socket progress | 0.224 / 0.388 / 0.462 ms |
| Exact client socket read | 0.240 / 0.430 / 0.476 ms |
| Outer write finish | 0.275 / 0.471 / 0.581 ms |

Trace-enabled measurements are diagnostic and are never silently mixed with compiled-out release baselines.
