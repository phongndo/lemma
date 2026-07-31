# Performance

Performance claims are measured rather than inferred from implementation language. Results below
are from the same Apple Silicon development machine and release builds. They are local baselines,
not universal rankings. They measure the current daemon-rendered ANSI architecture and remain
migration comparisons; they do not predict the selected checkpoint/event smart-client path.

## Renderer microbenchmarks

The workload uses an 80x24 Ghostty terminal. `full_frames` uses Ghostty's complete VT formatter.
`ansi_damage_frames` continuously appends styled lines. `ansi_single_row` alternates styled content
on one fixed row. `ansi_scroll_operations` verifies that each one-row shift is encoded with `SU`
rather than rewriting the 23 retained rows. Results are medians from three release repetitions on
July 15, 2026.

| Renderer | CPU per frame | Bytes per frame |
|---|---:|---:|
| Full-frame formatter | 177.8 us | 39,283 |
| Styled scrolling damage | 62.0 us | 49 average |
| Detected one-row scroll | 17.0 us | 90 |
| One changed cell span | 3.02 us | 90 |

The detected-scroll case is approximately 10.5x faster than full formatting and emits over 400x
fewer bytes. The sparse changed-span case is approximately 59x faster. Cell-span tracking adds a
bounded physical-cell array and performs no general allocation while rendering. Large VT parsing
measures approximately 1.2 GiB/s.

Reproduce the microbenchmarks with:

```sh
just profile=release bench
```

## Command and extension baselines

`benchmark_command_dispatch` measures validation plus one call through the allocation-free typed C++
dispatcher. It excludes the command-specific topology mutation so future CLI, keymap, and extension
transport measurements can separate dispatch overhead from the requested operation. The initial
Apple Silicon release smoke measured approximately 1.5 ns per dispatch on July 24, 2026; this is a
local regression baseline, not a cross-machine latency claim.

`benchmark_extension_registration_codec` measures one bounded typed command-registration encode and
incremental decode. It isolates framing cost from process scheduling so future socket round-trip,
event-flood, blocked-host, and pane-output backpressure benchmarks can report those costs separately.
Run it with:

```sh
./build/release/fiber_benchmarks \
  --benchmark_filter='command_dispatch|extension_registration_codec'
```

The extension host is never sampled from the PTY or renderer benchmark loops. An idle, blocked, or
crashed host must leave those baselines unchanged within measurement noise; end-to-end extension
latency does not justify moving Lua into the mux-critical path.

## Checked-in process benchmarks

[`../benchmarks/mux_benchmark.py`](../benchmarks/mux_benchmark.py) runs the real foreground daemon,
attached client, shell PTY, terminal adapter, renderer, and deterministic workload executable through
isolated endpoints. It records the Fiber commit, host/architecture, every latency sample, p50/p95/p99,
and client bytes as JSON. It never touches the user's daemon. The benchmark driver removes Ghostty's
shared source-tree `zig-out` before and after the run so a prior ReleaseFast archive cannot taint the
measurement or a later local debug/sanitizer build. Scheduled and manually dispatched extended CI
runs the smoke mode in an isolated checkout and uploads both JSON reports; shared-runner timings are
evidence, not thresholds.

Reproduce a release smoke or five-sample run with:

```sh
scripts/ci/benchmarks smoke
python3 benchmarks/mux_benchmark.py --mode all --repetitions 5 \
  --output build/release/mux-benchmark-results.json
```

The warm-scroll workload attaches an 80x24 client to a warm daemon/session, writes 25,000
79-column CRLF-terminated rows (approximately 2 MiB), then emits a completion marker. Time runs from
command submission until the marker is observable in the client render stream. Client bytes count
multiplexer-to-terminal output, not PTY input; the workload intentionally allows final-state
coalescing.

The blocked-PTY workload gates a foreground reader and sends a 2 MiB input payload until the attached
client is backpressured. In another workspace, a deterministic peer acknowledges each input token over
a fixture-owned Unix datagram socket immediately after reading it from the PTY, then echoes the token
to the rendered client stream. The report records separate `key_to_pty` and `key_to_visible`
distributions at idle and while the first PTY remains blocked. Finally, the harness releases the reader
and verifies exact byte-count/digest recovery.

Five release samples on the Apple Silicon development machine on July 30, 2026 produced:

| Workload | p50 | p95 | p99 | Median client bytes |
| --- | ---: | ---: | ---: | ---: |
| Warm 2 MiB scroll marker | 2.41 ms | 2.78 ms | 2.78 ms | 328 B |
| Responsive workspace, idle peer (key-to-visible) | 2.43 ms | 2.48 ms | 2.48 ms | not recorded per sample |
| Responsive workspace, other PTY blocked (key-to-visible) | 2.45 ms | 2.50 ms | 2.50 ms | not recorded per sample |

The blocked reader accepted 1,125,222 bytes through the outer client before backpressure was
observable in that run, then recovered the complete 2 MiB payload. Five samples are a smoke baseline,
not a statistically stable regression budget. Cross-multiplexer results are intentionally omitted
until checked-in adapters can reproduce the exact same workload and report binary versions.

This benchmark does not replace future sparse editor, mouse, multi-pane, slow-client,
large-scrollback, memory, resize-storm, or soak measurements.

## Replicated-terminal performance requirements

The target architecture must report work on both sides rather than describing moved client work as
eliminated. Its checked-in harnesses will measure:

- PTY-read-to-event availability, event-to-visible presentation, key-to-PTY, and key-to-visible
  p50/p95/p99;
- checkpoint encoded bytes, export/import time, peak temporary allocation, and attach-to-ready;
- recent and complete scrollback hydration time/bytes;
- acknowledged sequence lag, retained-tail bytes, lag detection, and forced-checkpoint recovery;
- raw event bytes for sparse editor, full redraw, synchronized update, and warm-scroll workloads;
- daemon and client CPU/wakeups/memory at 1, 4, 16, and maximum pane counts;
- compatibility ANSI and native presentation costs over the same replica traces; and
- the same core distributions over local Unix and shaped SSH transports.

Checkpoint plus event tail is the only target synchronization algorithm. Normal operation does not
wait for daemon ANSI composition. Output/history/checkpoint queues and scheduling remain bounded; a
lagging client resets from a fresh checkpoint instead of retaining an unbounded raw stream. Large
checkpoint/history/output compression is selected only by measured bytes/latency/CPU evidence.

No target performance claim is accepted until the checkpoint feasibility phase measures export,
import, size, and continuation costs. A native-performance claim additionally requires a native
presentation path; moving the existing ANSI compositor into a smart client proves architecture but
not the final key-to-pixel advantage.

## Current server-rendered performance invariants

- PTY parsing never waits for a steady-state client write.
- A reactor turn reads at most 256 KiB from the PTY.
- Output bursts are coalesced behind a 2 ms deadline.
- Only one bounded frame can be in flight per client.
- Ghostty dirty state accumulates while a client frame is blocked.
- A resize or attach invalidates physical row and cell state and forces a complete redraw.
- Dirty full-screen shifts are checked against bounded raw-cell row fingerprints.
- Dirty partial rows emit only their changed prefix/suffix span.
- No general allocation occurs while encoding an ANSI damage frame.
- The reactor reads extension IPC only after ready PTYs, client input, and due frames.
- Extension IPC has fixed frame, decoder, message-batch, registration, and UI bounds.
- The daemon never synchronously waits for Lua, and host disconnect clears extension state without
  stopping pane processes.

These invariants remain required until production cutover. After cutover, equivalent bounds apply to
pane event sequencing, checkpoint/history work, protocol writes, replica application, and client
presentation; obsolete daemon frame scheduling is removed rather than preserved beside the new path.
