# Core mux quality standard

## Purpose

Lemma's first product is a batteries-included local terminal multiplexer. It must be useful without
Lua, agents, packages, or user configuration. Extensibility may consume the same stable commands and
state later, but it does not substitute for complete built-in lifecycle, layout, input, history,
presentation, diagnostics, or compatibility behavior.

This document fixes the Phase 0 workload and quality standard. It is not an implementation backlog.
Current implementation claims remain in [`current-capabilities.md`](current-capabilities.md), and
measurement details and recorded results remain in [`performance.md`](performance.md).

## Phase 0 status

The standard is established: required workflows are inventoried, permanent invariants are recorded,
P1/P4/P16/PMAX profiles are machine-readable, common process workloads have exact completion
semantics, and pinned tmux/Zellij adapters produce versioned comparison reports. Release smoke
validates all report schemas and uploads the evidence. Timing thresholds remain deliberately unset
until repeated dedicated-host samples establish normal variance.

## Definition of “best”

A “best” claim requires all three dimensions:

1. **Correct:** accepted input is ordered, visible state is reconstructible, terminal behavior is
   compatible, and every supported workflow has defined failure behavior.
2. **Robust:** ownership and capacity are explicit; malformed, blocked, crashed, or slow peers have
   bounded impact; cleanup works on every reachable exit path.
3. **Fast by evidence:** latency, throughput, bytes, CPU, wakeups, and memory are measured end to end
   under identical completion semantics. C++ or an allocation-free loop is not itself evidence.

Lemma does not claim universal superiority from one workload. Reports identify the commit, binary
versions, build profile, host, architecture, dimensions, sample count, and raw samples.

## Batteries-included workflow contract

Status uses **Working**, **Partial**, and **Absent** with the meanings from the capability audit. The
IDs are stable test and benchmark vocabulary; they are not public command IDs.

| ID | Workflow required from the unconfigured binary | Baseline |
| --- | --- | --- |
| L1 | Plain `lemma` creates or enters a deterministic default session | Working |
| L2 | Create, list, attach, detach, rename, and kill named sessions | Partial |
| L3 | Client EOF, crash, or transport loss preserves pane processes | Working |
| L4 | Launch failures, child exit, capacity, and daemon shutdown report precise outcomes | Partial |
| T1 | Create, list, select, cycle, rename, reorder, and close tabs | Partial |
| T2 | Preserve tab identity, focus, zoom, layout, title, and inactive output | Partial |
| P1 | Split horizontally/vertically, focus, close, and zoom panes | Working |
| P2 | Preserve ratios and resize by keyboard and mouse | Absent |
| P3 | Identify panes and maintain a valid tree across resize and child exit | Partial |
| I1 | Deliver Unicode, control, Alt, function, navigation, legacy, and extended keys | Partial |
| I2 | Preserve bounded paste boundaries and application focus events | Partial |
| I3 | Hit-test mux chrome and forward pane-local application mouse input | Absent |
| H1 | Browse retained history without pausing PTY progress | Absent |
| H2 | Search and select by keyboard and mouse through one model | Absent |
| H3 | Copy correct text with an explicit bounded clipboard policy | Absent |
| R1 | Parse each PTY once and compose bounded terminal damage | Working |
| R2 | Reconstruct complete visible state on attach, resize, tab change, and lag recovery | Partial |
| R3 | Restore every outer-terminal mode on normal, failure, disconnect, and signal exits | Partial |
| C1 | Run representative shells, editors, pagers, REPLs, and TUIs locally | Partial |
| C2 | Run the same supported interaction baseline through ordinary SSH | Partial |
| O1 | Provide actionable help, version, diagnostics, and explicit lifecycle guarantees | Partial |

A row becomes complete only with documented success/failure behavior, explicit resource bounds,
component and process tests, and measurements for changed hot paths.

## Permanent robustness invariants

These apply in every phase and release build:

1. Every mutable mux, process, terminal, view, and connection object has one authoritative owner.
2. Every queue, payload, decoder, frame, allocation, batch, and reactor turn has a hard bound.
3. Capacity exhaustion is an observable result and never partially mutates topology.
4. Accepted application input and terminal-generated responses preserve required order.
5. A blocked PTY, client, or optional subsystem cannot prevent unrelated PTY progress.
6. The daemon can reconstruct current visible state without an unbounded event or render log.
7. Lag retains bounded presentation work and recovers by full redraw or disconnect.
8. Steady-state terminal parsing and ANSI damage encoding avoid the general heap.
9. Foreign terminal-library values do not cross the terminal adapter boundary.
10. Malformed external input is rejected before authoritative mutation.
11. Internal invariant failure is fail-fast in release builds rather than tolerated as corruption.
12. Every enabled outer-terminal mode has normal, partial-startup, error, signal, and disconnect
    cleanup coverage.
13. Performance evidence includes completion semantics and raw samples; failed or incomplete work is
    never reported as a fast sample.

## Standard workload profiles

[`../benchmarks/workloads.json`](../benchmarks/workloads.json) is the machine-readable profile
manifest.

| Profile | Panes | Purpose |
| --- | ---: | --- |
| P1 | 1 | Interactive shell, lowest latency, and steady-state overhead |
| P4 | 4 | Ordinary editor, shell, logs, and test layout |
| P16 | 16 | Heavy local workspace and inactive-pane pressure |
| PMAX | 64 | Supported per-session capacity and bounded exhaustion boundary |

The compositor microbenchmark evaluates P1/P4/P16/PMAX in a fixed 240x80 viewport so increasing pane
count does not silently increase total visible area. Process workloads use an 80x24 PTY unless their
report states otherwise. Future large-viewport results use a separately labeled 240x80 profile.

## Implemented process workloads

### Warm scroll

A warm attached shell runs the same fixture binary for every multiplexer. The fixture writes 25,000
79-column CRLF rows (about 2 MiB) and a unique marker. Time ends only when that marker is observable
in client output. The report retains every latency sample and client byte count.

### Idle resources

After the warm workload settles, the harness samples an attached shell for one second per repetition.
It records process-tree CPU-time deltas and ending RSS. On Darwin it also records package-idle and
interrupt wakeup deltas from `proc_pid_rusage`; systems without a reviewed wakeup counter report that
metric as unavailable rather than substituting context switches.

### Blocked PTY isolation

One session launches a gated raw-input peer and receives a 2 MiB payload. Another session runs a peer
that acknowledges each unique token at PTY receipt and then renders it. The report separates
key-to-PTY and key-to-visible latency before and during the blocked session, records whether client
backpressure was observable, and verifies the complete blocked payload byte count and digest after
release.

A multiplexer that buffers the complete payload reports that fact rather than being forced to exhibit
Lemma's backpressure policy. A multiplexer that disconnects or cannot produce the completion marker
reports a failed workload; it does not receive a latency result for incomplete work.

## Measurement matrix

| Area | Required observations | Phase 0 implementation |
| --- | --- | --- |
| Dispatch and codecs | CPU time per operation | Google Benchmark |
| VT parsing | bytes/second for small and 64 KiB writes | Google Benchmark |
| Damage rendering | sparse row, scroll, full frame, encoded bytes | Google Benchmark |
| Pane scaling | composition at P1/P4/P16/PMAX | Google Benchmark |
| Warm output | marker latency and daemon-to-client bytes | Process harness |
| Isolation | key-to-PTY, key-to-visible, backpressure, digest recovery | Process harness |
| Process footprint | post-workload process-tree RSS and consumed CPU time | Process harness |
| Idle operation | CPU, wakeups, and baseline RSS | Process harness; wakeups are OS-labeled |
| Interaction | paste, focus, mouse, resize, copy, and search latency | Added with each feature |
| Stress | output/resize floods, repeated lifecycle, and soak distributions | Required before release |

Portable process reports use `ps` for labeled RSS and CPU snapshots. Darwin wakeups use
`proc_pid_rusage`; other systems keep the wakeup field explicitly unavailable until they gain a
reviewed native counter rather than inferring wakeups from CPU usage or context switches.

## Comparable multiplexer policy

The development shell pins tmux and Zellij from the same locked Nix package set used by scheduled
runs. The comparator uses isolated homes/configuration, an isolated tmux socket, unique Zellij
sessions/socket directory, the same account shell, PTY dimensions, fixture executable, input bytes,
and completion markers. It records exact executable versions.

The comparison does not normalize away product architecture. For example, separate sessions may
share one server in one mux and use separate servers in another; process-tree resource and isolation
results deliberately include that choice. Default presentation remains enabled, while user
configuration, startup tips, release notes, and session serialization are disabled.

Run the reproducible suites with:

```sh
just profile=release bench
python3 benchmarks/mux_benchmark.py --mode all --repetitions 5 \
  --output build/release/mux-benchmark-results.json
python3 benchmarks/compare_mux.py \
  --lemma-report build/release/mux-benchmark-results.json \
  --repetitions 5 --output build/release/mux-comparison-results.json
```

`just mux-bench` builds the release binaries, runs microbenchmarks, runs Lemma's process suite, and
produces the three-multiplexer comparison report.

## Regression and claim policy

- Shared CI runner timings are artifacts for investigation, not merge thresholds.
- A stable workload needs enough dedicated-host samples to characterize normal variance before it
  receives a reviewed regression budget.
- Changes beyond that budget require explanation, correction, or an explicit reviewed tradeoff.
- Competitor versions and completion behavior are reported beside latency; missing work is not zero
  time.
- Performance documentation may claim only the measured workload on the recorded systems.
- Correctness, isolation, or bounded-memory regressions block an optimization regardless of speed.
