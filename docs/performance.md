# Performance

Performance claims are measured rather than inferred from implementation language. Results below
are from the same Apple Silicon development machine and release builds. They are local baselines,
not universal rankings. They measure the selected daemon-authoritative, server-rendered architecture.

## Renderer microbenchmarks

The workload uses an 80x24 Ghostty terminal. `full_frames` uses Ghostty's complete VT formatter.
`ansi_damage_frames` continuously appends styled lines. `ansi_single_row` alternates styled content
on one fixed row. `ansi_scroll_operations` verifies that each one-row shift is encoded with `SU`
rather than rewriting the 23 retained rows. Results are medians from three clean release
repetitions on August 9, 2026.

| Renderer | CPU per frame | Bytes per frame |
|---|---:|---:|
| Full-frame formatter | 177.2 us | 39,404 average |
| Styled scrolling damage | 72.5 us | 49 average |
| Detected one-row scroll | 16.8 us | 90 |
| One changed cell span | 3.14 us | 90 |

The detected-scroll case is approximately 10.5x faster than full formatting and emits over 400x
fewer bytes. The sparse changed-span case is approximately 56x faster. Cell-span tracking adds a
bounded physical-cell array and performs no general allocation while rendering. Large VT parsing
measured 1.22 GiB/s.

Reproduce the microbenchmarks with:

```sh
just profile=release bench
```

## Command and extension baselines

`benchmark_command_dispatch` measures validation plus one call through the allocation-free typed C++
dispatcher. It excludes the command-specific topology mutation so future CLI, keymap, and extension
transport measurements can separate dispatch overhead from the requested operation. The clean F0
release measured 2.63 ns per dispatch on August 9, 2026; this is a local baseline, not a
cross-machine latency claim.

`benchmark_extension_registration_codec` measures one bounded typed command-registration encode and
incremental decode. It isolates framing cost from process scheduling so future socket round-trip,
event-flood, blocked-host, and pane-output backpressure benchmarks can report those costs separately.
The same clean release measured 138 ns per registration encode/decode. Run it with:

```sh
./build/release/lemma_benchmarks \
  --benchmark_filter='command_dispatch|extension_registration_codec'
```

The extension host is never sampled from the PTY or renderer benchmark loops. An idle, blocked, or
crashed host must leave those baselines unchanged within measurement noise; end-to-end extension
latency does not justify moving Lua into the mux-critical path.

## F0 release process baseline

[`../benchmarks/mux_benchmark.py`](../benchmarks/mux_benchmark.py) runs the real foreground daemon,
attached client, shell PTY, terminal adapter, renderer, and deterministic workload executable through
isolated endpoints. Each workload and pane-profile condition gets a fresh runtime; attach-to-visible
also uses a fresh runtime per repetition and an untimed observe/detach validation before the measured
client, so the retained marker is known to be canonical before timing. Schema 4 records every latency
sample,
p50/p95/p99, client bytes, direct daemon/client roles, unclassified pane or mux children, the optional
extension-host outcome, and the complete process tree. A workload that does not reach its completion
marker remains a failure.

The benchmark never touches the user's daemon. The CI driver removes Ghostty's shared source-tree
`zig-out` before and after the run. Reproduce the clean five-sample baseline with:

```sh
rm -rf build/release
scripts/ci/benchmarks extended
```

This creates the raw reports under `build/release/`:

- `benchmark-results.json` (three release microbenchmark repetitions);
- `mux-benchmark-results.json` (five complete Lemma workload repetitions);
- `mux-comparison-results.json` (the same five repetitions through Lemma, tmux, and Zellij); and
- `mux-profile-results.json` (P1/P4/P16/PMAX idle and active conditions).

A clean pre-change parent run is retained as `f0-parent-119e8f8-*.json`. On unchanged workloads, the
parent/current warm-scroll results were 2.716/19.258 ms and 16.944/17.816 ms p50/p95; the current
five-sample run landed in a clustered slow mode described below. Parent/current renderer medians were
74.57/72.54 us for styled damage, 3.22/3.14 us for one changed span, 17.39/16.85 us for detected
scroll, and 179.49/177.21 us for a full frame. The expanded token and fresh-runtime semantics make
the other process rows baseline
replacements rather than strict parent comparisons. No scheduling policy changed.

The August 9, 2026 run used commit `119e8f8c0f4ff4ac99e964d8d0697f9b985d98f7`
with an intentionally dirty benchmark worktree on a MacBook Pro (Mac16,5), Apple M4 Max (12
performance plus 4 efficiency cores), 64 GiB RAM, macOS 26.5.2 / Darwin 25.5.0, Apple Clang 21.0.0,
CMake 4.3.4, and Python 3.14.7. The adapters resolved tmux 3.7b and Zellij 0.44.3. This was the
physical development host, not a shared runner. It was on local power but was not a
laboratory-isolated machine; host load and all raw samples are therefore retained. These five-sample
comparison distributions are descriptive; the larger pinned-host distributions and reviewed budgets
appear below.

The comparison workloads are:

- **warm scroll:** approximately 2 MiB of fixed rows followed by a visible completion marker;
- **attach to visible:** process launch and attach through observation of a marker already retained in
  the daemon's canonical screen;
- **interactive under output:** same-pane bounded continuous output while each token is acknowledged
  from the PTY and then observed in the outer client stream;
- **idle resources:** five one-second attached-shell samples; and
- **blocked PTY:** exact 2 MiB backpressure/recovery while a second session remains interactive.

### Five-sample mux comparison

All latency values below are p50/p95/p99. Bytes are the median mux-to-outer-terminal bytes. These are
workload-specific observations, not a general mux ranking.

| Mux | Workload | Latency | Client bytes |
|---|---|---:|---:|
| Lemma | Warm scroll | 2.36 / 2.64 / 2.64 ms | 675 B |
| tmux | Warm scroll | 50.31 / 146.02 / 146.02 ms | 31,810 B |
| Zellij | Warm scroll | 44.89 / 45.07 / 45.07 ms | 20,396 B |
| Lemma | Attach to visible | 2.79 / 2.87 / 2.87 ms | 1,031 B |
| tmux | Attach to visible | 5.04 / 5.49 / 5.49 ms | 514 B |
| Zellij | Attach to visible | 47.56 / 48.20 / 48.20 ms | 7,985 B |
| Lemma | Interactive under output, key to visible | 2.52 / 2.53 / 2.53 ms | 738 B |
| tmux | Interactive under output, key to visible | 1.31 / 1.37 / 1.37 ms | 113 B |
| Zellij | Interactive under output, key to visible | 11.80 / 12.53 / 12.53 ms | 6,144 B |

All five final Lemma warm-scroll samples were 2.24–2.64 ms. Earlier retained five- and thirty-sample
runs exercised a second approximately 17–20 ms mode; one thirty-sample run had seven samples above
10 ms while p50 remained 2.44 ms and p95 was 19.02 ms. F0 retains both modes and uses the larger
distribution for thresholds. Under the blocked-PTY workload, Lemma's other-session key-to-visible
result was 2.43/2.47/2.47 ms versus 2.37/2.41/2.41 ms with an idle peer; all 2 MiB were recovered.
tmux completed with 0.12/0.13/0.13 ms under backpressure. Zellij lost the
connection and is recorded as failed, not as a fast sample.

### Pane profiles and process roles

An idle profile contains only live shells during its resource interval and launches its latency peer
afterward. An active profile emits bounded continuous output only in the focused pane while the other
panes remain live and idle. CPU is process-tree CPU consumed per one-second interval. Latency is the
focused pane's key-to-visible p50/p95; PMAX is the supported 64-pane per-session capacity.

| Profile | Condition | Tree RSS | Daemon RSS | Client RSS | CPU / s | Key to visible |
|---|---|---:|---:|---:|---:|---:|
| P1 | idle | 28.22 MiB | 23.73 MiB | 1.55 MiB | 0.00 ms | 2.38 / 2.44 ms |
| P1 | active | 27.42 MiB | 24.50 MiB | 1.55 MiB | 2.58 ms | 2.48 / 2.59 ms |
| P4 | idle | 38.28 MiB | 25.00 MiB | 1.55 MiB | 0.00 ms | 2.48 / 2.51 ms |
| P4 | active | 37.48 MiB | 25.75 MiB | 1.55 MiB | 1.70 ms | 2.48 / 2.52 ms |
| P16 | idle | 77.98 MiB | 29.45 MiB | 1.55 MiB | 0.00 ms | 2.48 / 2.51 ms |
| P16 | active | 77.27 MiB | 30.23 MiB | 1.55 MiB | 1.99 ms | 2.50 / 3.74 ms |
| PMAX | idle | 236.41 MiB | 46.88 MiB | 1.55 MiB | 0.00 ms | 2.57 / 2.62 ms |
| PMAX | active | 235.55 MiB | 47.64 MiB | 1.55 MiB | 3.07 ms | 2.62 / 2.75 ms |

The empty benchmark configuration explicitly disables the extension host, which is reported as
unavailable rather than folded into another role. P1 idle measured 0 daemon, 0 attached-client, and 0
total wakeups in every one-second sample. The reviewed Darwin mechanism is
`proc_pid_rusage(RUSAGE_INFO_V0)` package-idle plus interrupt wakeups; platforms without a reviewed
per-process wakeup counter report unavailable and do not substitute context switches or another
unrelated counter. tmux P1 idle process-tree RSS was 9.89 MiB under the same completion semantics.

## Reviewed F0 regression budgets

Run the pinned-host gate with:

```sh
scripts/ci/regression-budgets
```

The command forces tracing off, performs ten raw microbenchmark repetitions, thirty process-workload
repetitions, and twenty repetitions of every pane-profile condition, then evaluates the raw samples
with [`../benchmarks/check_regression.py`](../benchmarks/check_regression.py). The manifest in
[`../benchmarks/workloads.json`](../benchmarks/workloads.json) is the source of truth. It records the
host scope, minimum sample counts, nearest-rank statistic, units, and thresholds. Shared CI validates
that manifest but does not apply pinned-host thresholds.

The reviewed runs retained `regression-{microbenchmarks,process-workloads,pane-profiles}.json` and
`regression-budget-results.json` under `build/release/`; the final 66-check evaluation passed. The
largest relevant statistic observed across repeated gate and targeted confirmation runs and its
limit were:

| Gate | Observed | Maximum |
|---|---:|---:|
| Styled damage CPU p95 | 78.89 us | 87.00 us |
| One-row span CPU p95 | 3.45 us | 3.80 us |
| Detected-scroll CPU p95 | 19.25 us | 21.20 us |
| Full-frame CPU p95 | 182.03 us | 200.00 us |
| Warm-scroll latency p50 / p95 | 2.57 / 19.83 ms | 3.00 / 21.00 ms |
| Warm-scroll bytes p50 / p95 | 687 / 1,998 B | 720 / 2,200 B |
| Attach-to-visible p50 / p95 | 4.21 / 4.82 ms | 4.70 / 5.40 ms |
| Same-pane-output key-to-PTY p50 / p95 | 1.26 / 1.38 ms | 1.40 / 1.50 ms |
| Same-pane-output key-to-visible p50 / p95 | 2.73 / 3.63 ms | 3.00 / 4.00 ms |
| Same-pane-output bytes p95 | 806 B | 1,100 B |
| Idle tree CPU p95 / wakeups max | 0 ms / 0 | 1 ms / 0 |
| Idle peer key-to-visible p95 | 3.26 ms | 3.60 ms |
| Other-session blocked key-to-PTY p95 | 0.310 ms | 0.350 ms |
| Other-session blocked key-to-visible p95 | 4.24 ms | 4.50 ms |

Warm scroll produced three approximately 20 ms samples among thirty; its p95 budget includes that
measured mode instead of dropping it. The same-pane-output fixture now waits for a peer receipt after
its bounded post-echo rendering opportunity, outside the next measured interval. Its reviewed limits
include the resulting startup byte transients rather than discarding them. Renderer CPU and byte
limits cover the largest p95 seen across repeated runs plus approximately 10% outward rounding.
Latency and codec limits likewise cover the multi-run envelope, rather than only the fastest run.
Tree-RSS limits are 32/50/112/360 MiB
for P1/P4/P16/PMAX. The larger profiles were refreshed from the current release footprint with an
approximately 10% outward margin for page-level allocator and OS variance. Every profile also gates p95 CPU,
key-to-PTY, and key-to-visible; the exact values remain machine-readable in the manifest.

A missing sample, wrong unit, incomplete workload, report from outside the reviewed host class, or
unavailable process-report wakeup measurement is an invalid gate rather than a pass. The gate also
matches every report against the reviewed hostname, Mac16,5 model, Apple M4 Max CPU, 16 physical
cores, and 64-GiB memory fingerprint; merely running on another 16-core arm64 Mac is not sufficient.
A measured value above a limit is a regression failure. Threshold changes require retaining a new raw
distribution and reviewing the manifest change; shared-runner observations alone do not justify
widening a budget.

## F1 interactive urgency results

F1 replaces the immediate/delayed boolean with the allocation-free `FrameScheduler`. Its explicit
urgencies are `interactive`, `state_change`, and `burst`. Keystroke-sized physical input messages of
1–64 bytes set one bounded bit on the pane that was focused when the daemon accepted the input; the
first subsequent visible damage from that pane promotes the session deadline to now. Larger physical
input chunks retain burst coalescing so bounded paste and generated bulk input do not turn every
chunk into a frame. Focus, layout, resize, attach, pane exit, and status changes are immediate.
Autonomous output retains the 2 ms coalescing deadline.

The scheduler owns one deadline and one full-redraw bit. A later request can only advance the
existing deadline, never postpone it. A blocked frame retains canonical damage but exposes no timer
deadline until the retained output drains. Detach cancels the deadline, and requests without an
attached client are ignored. Consequently an idle attached or detached session has no frame timer.
Deterministic component tests cover input classification, promotion, burst continuation, blocked
output, resize, detach, and no-client behavior.

The final tracing-off release gate retained raw output in
`regression-{microbenchmarks,process-workloads,pane-profiles}.json`. The F0 comparison column below is
from the retained `f0-budget-lemma-30.json`; F1 is the final thirty-sample process report. Values are
p50/p95.

| Workload and metric | F0 | F1 |
|---|---:|---:|
| Idle peer key to PTY | 0.095 / 0.214 ms | 0.065 / 0.102 ms |
| Idle peer key to visible | 2.615 / 3.014 ms | 0.168 / 0.234 ms |
| Peer key to PTY with another session blocked | 0.086 / 0.228 ms | 0.070 / 0.096 ms |
| Peer key to visible with another session blocked | 2.609 / 3.098 ms | 0.227 / 0.257 ms |
| Same-pane output, key to PTY | 1.170 / 1.291 ms | 1.222 / 1.281 ms |
| Same-pane output, key to visible | 2.503 / 2.546 ms | 1.371 / 1.409 ms |
| Warm-scroll completion | 2.567 / 19.825 ms | 2.415 / 16.358 ms |
| Warm-scroll client bytes | 675 / 1,867 B | 675 / 1,764 B |

The loaded same-pane fixture deliberately includes its approximately 1.2 ms key-to-PTY peer time;
its remaining PTY-to-visible interval no longer contains the 2 ms frame floor. The isolated local
path meets the provisional end-to-end target directly. In the trace-enabled final run, idle and
blocked-peer key-to-visible were 0.185/0.245/0.254 ms and 0.226/0.263/0.279 ms p50/p95/p99.

Causal trace version 2 accepted all 200 idle/blocked inputs with exact tokens, zero rejected paths,
and zero drops. The final report is `f1-trace-correlated-final-100-events.json`:

| Correlated monotonic interval | F0 p50 | F1 p50 | F1 p95 | F1 p99 |
|---|---:|---:|---:|---:|
| Client input read → daemon input decoded | 22 us | 15 us | 28 us | 34 us |
| Daemon decode → focused PTY write | 12 us | 7 us | 15 us | 18 us |
| PTY write → exact echoed PTY output read | 30 us | 20 us | 36 us | 40 us |
| Echoed PTY output read → composition start | 2,336 us | 18 us | 28 us | 40 us |
| Composition start → Ghostty damage report | 5 us | 2 us | 5 us | 14 us |
| Ghostty damage report → composition finish | 152 us | 94 us | 125 us | 137 us |
| Composition finish → daemon socket progress | 5 us | 2 us | 5 us | 7 us |
| Daemon socket progress → matching client read | 13 us | 8 us | 12 us | 15 us |
| Client read → outer write start | 0 us | 0 us | 1 us | 1 us |
| Outer write start → finish | 5 us | 2 us | 3 us | 5 us |

Physical input to outer-write completion is 0.180/0.226/0.244 ms p50/p95/p99, down from
2.580/2.764/3.172 ms. This removes the causally identified floor rather than shifting it to another
stage.

Warm-scroll p50 bytes were unchanged, while p95 bytes and latency improved in this distribution.
F1/F0 renderer medians were 76.14/72.54 us for styled damage, 3.26/3.14 us for one changed row span,
17.69/16.85 us for detected scroll, and 175.84/177.21 us for a full frame. The incremental medians
changed by 3.9–5.0%, within the established distribution and unchanged F0 p95 limits; full frames
improved by 0.8%. Thirty idle-resource repetitions and every twenty-sample P1/P4/P16/PMAX idle
profile reported zero wakeups.

The reviewed manifest now applies 68 checks. It tightens process idle/blocked key-to-visible p95 to
0.5 ms, adds p50 limits of 0.25/0.30 ms, tightens same-pane p50/p95 to 1.6/1.8 ms, and sets profile
idle p50/p95 to 0.25/0.5 ms and active p50/p95 to 1.6/1.8 ms. No F0 CPU, byte, memory, key-to-PTY,
wakeup, correctness, or completion gate was widened.

## F2 attached-client output results

F2 removes descriptor I/O from `src/render/`. Composition fills one retained frame; the core owns
partial writes, EINTR/EAGAIN handling, readiness, progress timestamps, deadlines, and disconnect.
One client can write at most 64 KiB in 32 attempts per turn, all attached clients share a 256 KiB
turn budget, and a persistent cursor rotates the first visited client. A frame has a 5 s no-progress
and 30 s total deadline. Poll uses the earlier deadline, so a blocked client has one deadline wakeup
rather than retrying on unrelated PTY activity. These limits are separate from and do not change the
256 KiB PTY-read, 64 KiB per-pane PTY-write, or 1 MiB global PTY-write bounds.

An in-flight frame is never replaced, including by resize or tab change. New damage remains in the
canonical terminals. The scheduler records one pending forced-full request without exposing a render
timer while blocked; after the old frame drains, one complete frame repairs the latest viewport. The
renderer has no socket headers or calls. Injectable-writer tests force partial progress, EINTR,
EAGAIN, per-client/global exhaustion, no-progress and total expiry, sixteen writable clients,
continuous low-slot replenishment, a 100-update pane flood, and actual forced-full composition.

The release process workload adds a raw 500x200 attached peer with a 4 KiB requested receive buffer.
After its initial frame blocks, that pane runs an unbounded `yes` flood while a different session
runs thirty exact-token interactions. Completion requires every token and automatic detach of the
non-reader. The final run detached it after 5.016 s. Draining ready PTYs before ordinary client input
did not harm this direct flooded condition, so the conditional focused latency lane was not added:

| Blocked-client workload | Idle p50 / p95 / p99 | Flood + non-reader p50 / p95 / p99 |
|---|---:|---:|
| Other-session key to PTY | 0.077 / 0.099 / 0.103 ms | 0.046 / 0.060 / 0.062 ms |
| Other-session key to visible | 0.203 / 0.288 / 0.294 ms | 0.147 / 0.159 / 0.168 ms |

The loaded/idle key-to-visible p95 ratio was 0.552. The reviewed comparative limit is 1.10; a faster
loaded sample is retained as observed rather than treated as negative overhead. Absolute p50/p95/p99
and key-to-PTY limits also apply. Nearest-rank p99 limits cover the largest retained thirty-sample
host modes (up to 0.734 ms in isolation runs) while the tighter pre-existing p50/p95 gates remain
unchanged.

The final trace-off release evaluation combines `f2-final-microbenchmarks.json`,
`f2-final-process-workloads.json`, `f2-final-pane-profiles.json`, and
`f2-final-budget-results.json`. It passed 80 checks. One complete profile run
hit 1.801 ms for P1 active p95 and 0.715 ms for PMAX idle p95; that failed report is retained as
`f2-pane-profiles-loaded-failure-20.json`, and a complete twenty-sample profile retry passed the
unchanged 1.8/0.5 ms limits. No threshold was widened. Parent/F2 selected results are:

| Metric | F1 parent | F2 final |
|---|---:|---:|
| Warm-scroll p50 / p95 | 2.415 / 16.358 ms | 2.295 / 2.428 ms |
| Warm-scroll bytes p50 / p95 | 687 / 1,764 B | 687 / 687 B |
| Same-pane key-to-PTY p50 / p95 | 1.222 / 1.281 ms | 1.236 / 1.309 ms |
| Same-pane key-to-visible p50 / p95 / p99 | 1.371 / 1.409 / 1.418 ms | 1.427 / 1.483 / 1.518 ms |
| Styled damage CPU p95 | 76.80 us | 74.24 us |
| One-row span CPU p95 | 3.29 us | 3.21 us |
| Detected-scroll CPU p95 | 17.82 us | 17.80 us |
| Full-frame CPU p95 | 181.37 us | 183.93 us |

All twenty idle profile repetitions at P1/P4/P16/PMAX and all thirty idle-resource repetitions still
reported zero wakeups. Tree RSS stayed inside the unchanged limits. A trace-enabled thirty-sample
blocked-PTY run produced 9,102 events, sixty complete exact-token paths, zero rejected paths, and zero
drops. PTY output to composition was 23/48/91 us and composition finish to core socket progress was
3/6/13 us p50/p95/p99, preserving the F1 trace boundary after descriptor progress moved into core.

## F3 memory ownership results

F3 began with an untouched-code compiler layout census and dedicated five-sample Lemma/tmux
P1/P4/P16/PMAX reports. The raw pre-change files are
`f3-baseline-ce1173c-{lemma,tmux}-profiles-5.json` and
`f3-baseline-ce1173c-engine-record-layouts.txt`. The first owner was the 17,318,912-byte eager table
of 128 pending setup objects. Making each live setup one lazy slot-owned RAII object reduced P1
daemon RSS from 24,952,832 B to 7,716,864 B. The next owner was the eager 4-MiB/session retained
frame. Replacing it with attached-only viewport capacity reduced P1 daemon RSS to 3,719,168 B. No
smaller owner was changed before those isolated reruns.

The final frame owner is 32 inline bytes, zero dynamic bytes while detached, 679,936 B at 80x24,
and at most 4 MiB. Its viewport rule is `4 KiB + 352 B/cell`, clamped to 64 KiB–4 MiB. Growth
occurs only at attach/resize, prepares replacement storage before commit, preserves an in-flight
frame prefix, and leaves old state valid on failure. Composition and client
flush receive spans and make no frame allocation. PTY queues remain lazy under a 1,114,112-byte
per-pane/128-MiB aggregate quota, but now reuse drained capacity. A no-config daemon allocates no
extension runtime and launches no Lua process; an opted-in host has a deterministic 16-MiB Lua
allocation quota.

`scripts/ci/memory extended` reproduces the complete census and final reports. P1 idle process-tree
RSS fell from 28.30 MiB to 7.70 MiB; identical tmux completion semantics measured 10.00 MiB, for a
0.770 ratio against the 1.5 limit. Final idle tree/daemon RSS was 17.83/4.52 MiB at P4,
57.55/8.98 MiB at P16, and 216.12/26.64 MiB at PMAX. Shell descendants, not daemon allocations,
dominate the larger tree totals. The byte-level owner table, component deltas, stripped executable
sizes, stack bound, and interpretation are in [`memory.md`](memory.md).

The 25,000-row history workload increased daemon RSS by 802,816 B while remaining under the
terminal's 10,000-byte logical history quota. Ghostty page granularity and active/page-pool retention
are reported rather than hidden. A 100-cycle create/attach/split/close/detach/kill workload reached
4,800,512 B at cycle 67 and stayed exactly there for the final 34 cycles; its final 25-sample range
was zero.

The final tracing-off release evaluation combines `regression-microbenchmarks.json`,
`regression-process-workloads.json`, `regression-pane-profiles.json`, and
`regression-budget-results.json`. All 80 unchanged F0-F2 checks passed. The complete post-review run
is also retained in the four `f3-final-postreview-*.json` reports (microbenchmarks-10,
process-workloads-30, pane-profiles-20, and budget-results). Two earlier complete profile runs that
exceeded unchanged loaded-latency
limits remain retained as `f3-regression-pane-profiles-failed-20.json` and
`f3-final-pane-profiles-retry-20.json`; no budget was widened. The final twenty-sample run passed
every profile CPU, RSS, key-to-PTY, and key-to-visible limit. All thirty idle-resource wakeup samples
were zero.

Selected F2-parent/F3 results are:

| Metric | F2 final | F3 final |
|---|---:|---:|
| Warm-scroll p50 / p95 | 2.295 / 2.428 ms | 2.297 / 2.403 ms |
| Warm-scroll bytes p50 / p95 | 687 / 687 B | 687 / 687 B |
| Same-pane key-to-PTY p50 / p95 | 1.236 / 1.309 ms | 1.220 / 1.281 ms |
| Same-pane key-to-visible p50 / p95 / p99 | 1.427 / 1.483 / 1.518 ms | 1.424 / 1.492 / 1.678 ms |
| Styled damage CPU median | 78.98 us pre-F3 | 72.17 us |
| One-row span CPU median | 3.30 us pre-F3 | 3.11 us |
| Detected-scroll CPU median | 18.14 us pre-F3 | 16.92 us |
| Full-frame CPU median | 180.24 us pre-F3 | 175.65 us |

The p99 same-pane sample moved within the existing measured host distribution while p50/p95, bytes,
and every reviewed threshold passed. Blocked-client loaded/idle key-to-visible p95 remained 0.589,
below the unchanged 1.10 isolation limit.

## F4 private attach framing results

F4 replaces the attach byte stream with private protocol 1.0 while leaving renderer authority and
F2's retained-output ownership intact. The fixed cost is 16 bytes on every message and another four
bytes on every render frame for its full-redraw generation. `benchmark_private_attach_input_codec`
measures deterministic framed-byte copy, validation, decode, and consume at 6.18 ns median in the
final three-repetition release run; the header is prepared outside the timed loop. This codec cost is separate from end-to-end scheduling evidence.

The framing-aware trace run `f4-framing-trace-interactive-30-benchmark.json` retained its raw mmap
files in `f4-framing-trace-interactive-30/` and its decoded paths in
`f4-framing-trace-interactive-30-events.json`. Forty-eight composed frames carried 21,434 ANSI bytes;
the F2 socket queue wrote 22,394 bytes. The exact 960-byte difference is 48 x 20-byte framing,
or **4.48%**. `f4-framing-overhead.json` retains the stage counts, byte sums, formula, and provenance.
Outer-terminal byte metrics intentionally remain ANSI-only because the client strips validated
framing before writing the terminal; every schema-4 Lemma report now says so explicitly.

The final five-repetition trace-off extended run is retained in the four
`f4-final-{benchmark-results,mux-benchmark-results,mux-comparison-results,mux-profile-results}.json`
reports. Selected results are:

| Metric | F3 final | F4 final extended |
|---|---:|---:|
| Warm-scroll p50 / p95 | 2.297 / 2.403 ms | 2.730 / 18.942 ms |
| Warm-scroll outer ANSI bytes p50 | 687 B | 687 B |
| Attach-to-visible p50 / p95 | 3.020 / 3.417 ms parent gate | 7.367 / 8.032 ms post-review |
| Same-pane key-to-PTY p50 / p95 | 1.220 / 1.281 ms | 1.332 / 1.482 ms |
| Same-pane key-to-visible p50 / p95 | 1.424 / 1.492 ms | 1.401 / 1.639 ms |
| Same-pane outer ANSI bytes p50 | workload-dependent | 283 B |
| Blocked-client other-session visible p50 / p95 | 0.147 / 0.159 ms | 0.095 / 0.102 ms |
| Blocked-client disconnect | 5.016 s | 5.008 s |
| P1 idle tree / daemon RSS | 7.70 / 3.20 MiB | 8.83 / 3.19 MiB |

Adding framing initially exposed a host mode in which a non-reading 500x200 session's unbounded PTY
flood could consume the whole 256 KiB daemon read allowance before unrelated input ran. The final
reactor preserves that daemon-wide limit but gives a session with retained blocked output a 4 KiB
PTY-read isolation slice per turn. The final five-sample loaded/idle p95 ratio was 0.685, and the
30-sample retained run measured 0.162 ms loaded p95. This is the F4 adaptation of F2 fairness, not a
new latency lane or feature.

The attached client's bounded 4,194,324-byte decoder allocation remains lazy. Final P1 client RSS
was 1.62 MiB. The bounded signal-restoration helper adds a measured 1,130,496-B P1 child marginal;
including it, P1 tree RSS remained 0.890x tmux. One hundred lifecycle cycles reached a stable
4,997,120-byte daemon plateau for the final 21 samples, and history increased daemon RSS by 786,432
B. Complete raw F3-preservation evidence is copied under `f4-final-memory-*`.

The pinned host entered a slower scheduling mode during the final absolute 80-check gate attempts.
The retained `f4-final-regression-budget-results.json` is marked failed rather than relabeled: the
post-review safety helper also makes attach startup exceed its old 4.7/5.4 ms p50/p95 limits
(7.367/8.032 ms in `f4-final-attach-visible-30.json`), while steady same-pane key-to-PTY remained
1.332/1.482 ms and several idle/profile tails also crossed unchanged limits. No limit was widened. To distinguish code effect from host state, an
unchanged `185c395` release worktree was built and run on the same host in the same interval.
`f4-concurrent-parent-process-workloads.json`, `f4-concurrent-parent-pane-profiles.json`, and
`f4-concurrent-comparison.json` retain the raw comparison. The parent itself missed the same absolute
budgets (same-pane key-to-PTY 1.499/1.648 ms p50/p95); F4 measured 1.450/1.547 ms in the paired run.
Same-pane visible p50 was within 0.3%, p95 was +4.62%, profile active CPU medians differed by at most
1.3%, attach improved, outer bytes did not increase, and blocked-client isolation improved. Earlier
complete failed attempts are retained as `f4-regression-*-failed-*.json`. These results preserve every
reviewed threshold and demonstrate no material F4 regression outside the concurrently reproduced
host variance, while honestly retaining the unavailable clean absolute-gate outcome.

## Opt-in key-to-visible trace

Normal builds compile the trace-recording API to inline no-ops and omit trace-only matcher/state
fields. `LEMMA_ENABLE_LATENCY_TRACE` defaults to `OFF`, and the release benchmark script passes `OFF`
explicitly. A diagnostic build must opt in at
both build time and runtime:

```sh
scripts/ci/configure release -DLEMMA_BUILD_TESTS=OFF \
  -DLEMMA_ENABLE_LATENCY_TRACE=ON
cmake --build --preset release --target \
  lemma_test_server lemma_test_cli lemma_test_pty_peer
rm -rf build/release/f0-trace-correlated-v2-100
python3 benchmarks/mux_benchmark.py --mode blocked-pty --repetitions 100 \
  --trace-directory build/release/f0-trace-correlated-v2-100 \
  --output build/release/f0-trace-correlated-v2-100-benchmark.json
python3 benchmarks/latency_trace.py \
  --directory build/release/f0-trace-correlated-v2-100 \
  --input-bytes 29 --input-bytes 32 \
  --output build/release/f0-trace-correlated-v2-100-events.json
# Restore the ordinary release configuration before non-diagnostic measurements.
scripts/ci/configure release -DLEMMA_BUILD_TESTS=OFF \
  -DLEMMA_ENABLE_LATENCY_TRACE=OFF
```

`LEMMA_LATENCY_TRACE` names a user-owned absolute directory. Each daemon or attached client writes
one 1,310,784-byte mmap file containing a 64-byte header and at most 32,768 fixed 40-byte events.
Overflow retains the bounded prefix and increments `dropped`; there is no allocation, formatting, or
trace-output syscall per event. The decoder rejects invalid magic, versions, roles, sizes, stages,
sequence, and bounds.

Trace version 2 adds a 64-bit correlation field. Each controlled input contains a unique bounded
`_XXXXXXXX__` suffix. Trace-enabled code encodes the exact eight-letter payload independently when the
attached client reads it, the daemon decodes it, the focused PTY actually accepts it, and the peer's
exact echo is read back. The resulting focused frame retains that token through Ghostty damage,
composition, daemon socket progress, client receipt, and outer-terminal write completion. The client
accepts a visible suffix only when it matches its single pending controlled input; this avoids
mistaking autonomous uppercase output for causality. All matchers, the per-pane input/output state,
the per-session pending frame token, and the per-client output token are fixed-size and exist only in
trace-enabled builds.

The schema-3 decoder requires the same nonzero token at every ordered boundary and requires all client
stages to come from the physical-input process. It never falls back to a timestamp window. Two
hundred isolated idle/blocked inputs produced 11,325 raw events, 200 complete paths, zero rejected
paths, and zero drops. A separate same-pane autonomous-output run produced 1,479 raw events and 100
complete paths with zero rejections and zero drops, demonstrating token attribution while unrelated
output is interleaved. Adjacent-stage distributions for the isolated idle/blocked run were:

| Correlated monotonic interval | p50 | p95 | p99 |
|---|---:|---:|---:|
| Client input read → daemon input decoded | 22 us | 57 us | 66 us |
| Daemon decode → focused PTY write | 12 us | 30 us | 35 us |
| PTY write → exact echoed PTY output read | 30 us | 48 us | 83 us |
| Echoed PTY output read → composition start | 2,336 us | 2,413 us | 2,571 us |
| Composition start → Ghostty damage report | 5 us | 14 us | 17 us |
| Ghostty damage report → composition finish | 152 us | 187 us | 251 us |
| Composition finish → daemon socket progress | 5 us | 15 us | 21 us |
| Daemon socket progress → matching client read | 13 us | 20 us | 27 us |
| Client read → outer write start | 0 us | 1 us | 1 us |
| Outer write start → finish | 5 us | 15 us | 29 us |

Physical input to outer-write completion was 2.580/2.764/3.172 ms p50/p95/p99. The dominant
adjacent interval is the 2.336 ms median between resulting PTY output and composition start, which
identifies the unchanged delayed-frame floor without changing scheduling policy.

A separate 100-sample same-pane-output comparison measured a normal trace-compiled-out release
against an active trace-version-2 build after the same bounded cooldown. Key-to-visible was
2.640/2.801/2.861 ms compiled out and 2.634/2.846/3.086 ms active. The active median was 5.6 us
lower; p95 increased 44.5 us (1.59%), and p99 increased 224.6 us (7.85%). The raw distributions are
reported without treating the faster median as negative overhead. This is a diagnostic-build cost,
not production hot-path work; all raw samples are retained in
`build/release/f0-trace-{compiled-off,enabled}-v2-100.json`.

[`../benchmarks/compare_mux.py`](../benchmarks/compare_mux.py) runs the common peer binary, PTY size,
input, marker, and completion condition through pinned adapters. The locked definitions are in
[`../benchmarks/workloads.json`](../benchmarks/workloads.json), and comparison rules are in
[`core-mux-quality.md`](core-mux-quality.md). This baseline does not replace future sparse-editor,
slow-client, large-scrollback, resize-storm, or soak measurements.

## Checkpoint feasibility measurements

The archived checkpoint feasibility gate used a temporary 16 MiB-bounded reconstructive-VT prototype and
release measurement executable. It was a negative feasibility artifact, not production code. The
prototype and target were removed after the server-rendered decision; the retained results document
the rejected option and are not a current benchmark command.

Apple Silicon release results on August 1, 2026 ranged from 5.7 KiB and 17.4–23.2 us export p50 for
empty terminals to 98.4 KiB and 831.9 us for the 80x24 maximum-retained-history workload. Import p50
ranged from 75.8 to 279.7 us. A 240x80 shell-like state encoded 29.9 KiB, exported in 175.3 us p50,
and imported in 123.7 us p50. Zstd level 1 reduced the highly repetitive synthetic payloads to
1.0–2.1 KiB, which supports measuring large-state compression but says nothing about tiny
interactive frames.

The benchmark also exposed a disqualifying scaling property: the formatter places all retained
active-screen history on the ready path, and no range hydration API exists. More importantly, tests
prove that the measured payload cannot continue incomplete CSI/UTF-8 state or restore an inactive
primary screen. Full tables, bounds, and interpretation are in
[`terminal-checkpoint-feasibility.md`](terminal-checkpoint-feasibility.md).

## Server-rendered performance requirements

The production harnesses measure the complete daemon/client path rather than treating daemon work as
free. Required distributions include:

- PTY-read-to-frame, key-to-PTY, key-to-visible, and attach-to-visible p50/p95/p99;
- full-redraw generation and recovery after client backpressure;
- bytes for sparse editor, full redraw, synchronized update, and warm-scroll workloads;
- copy/search/mouse interaction latency and large retained-history traversal;
- daemon and thin-client CPU, wakeups, and memory at 1, 4, 16, and maximum pane counts;
- blocked clients, blocked PTYs, resize storms, inactive tabs, and extension-host failures;
- JSON and persistent-agent command, snapshot, launch, capture, wait, cancel, and event latency/bytes
  under concurrent PTY/render load; and
- the same core observations during ordinary SSH operation where the transport permits measurement.

Relative performance claims require checked-in adapters and identical completion semantics for pinned
tmux, Zellij, Herdr, and Lemma versions. Lemma may claim a workload-specific measured advantage, not
an unsupported universal “fastest multiplexer” label.

Only bounded complete frames are queued. New output while a frame is blocked remains represented by
canonical damage rather than an output log. After progress resumes, one full redraw repairs the
presentation; a client that misses its deadline disconnects. Compression is considered only for
measured large framed values and never assumed beneficial for interactive ANSI.

Native performance is not a 1.0 claim. A later native presentation path receives replaceable
presentation snapshots/deltas and requires its own end-to-end evidence.

## Server-rendered performance invariants

- PTY parsing never waits for a steady-state client write.
- A reactor turn reads at most 256 KiB from the PTY.
- Keystroke-sized accepted input and visible mux state changes promote frame composition immediately.
- Sustained autonomous output remains coalesced behind one non-postponing 2 ms deadline.
- A blocked frame exposes no rendering timer, and idle operation has no frame deadline.
- Only one bounded frame can be in flight per client; renderer code performs no socket I/O.
- Core client writes are limited to 64 KiB/32 attempts per client and 256 KiB globally per turn, with
  a persistent round-robin cursor.
- An in-flight frame has a 5 s no-progress and 30 s total deadline.
- Ghostty dirty state accumulates while a client frame is blocked and repairs with one full redraw.
- A resize or attach invalidates physical row and cell state and forces a complete redraw.
- Dirty full-screen shifts are checked against bounded raw-cell row fingerprints.
- Dirty partial rows emit only their changed prefix/suffix span.
- No general allocation occurs while encoding an ANSI damage frame.
- The reactor reads extension IPC only after ready PTYs, client input, and due frames.
- Extension IPC has fixed frame, decoder, message-batch, registration, and UI bounds.
- The daemon never synchronously waits for Lua or automation clients; host/client disconnect clears
  their bounded subscriptions without stopping pane processes.

These invariants are permanent production requirements. The versioned protocol must preserve them
while adding complete render-frame boundaries, full-redraw epochs, progress deadlines, and precise
mismatch/error behavior.
