# Performance

Performance claims are measured rather than inferred from implementation language. Results below
are from the same Apple Silicon development machine and release builds. They are local baselines,
not universal rankings.

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

## Extension IPC baseline

`benchmark_extension_registration_codec` measures one bounded typed command-registration encode and
incremental decode. It isolates framing cost from process scheduling so future socket round-trip,
event-flood, blocked-host, and pane-output backpressure benchmarks can report those costs separately.
Run it with:

```sh
./build/release/fiber_benchmarks --benchmark_filter=extension_registration_codec
```

The extension host is never sampled from the PTY or renderer benchmark loops. An idle, blocked, or
crashed host must leave those baselines unchanged within measurement noise; end-to-end extension
latency does not justify moving Lua into the mux-critical path.

## Warm-session multiplexer comparison

A pseudoterminal harness attached an 80x24 client to a warm session, then ran a process that wrote
25,000 79-column lines (approximately 2 MiB) followed by a generated completion marker. Time was
measured from submitting the command until the marker was observable in the client render stream.
Client bytes count multiplexer-to-terminal output, not PTY input. Five runs were performed and the
median is reported.

| Multiplexer | Version | Marker latency | Client bytes |
|---|---:|---:|---:|
| Fiber | current release | 29.3 ms | 17.2 KiB |
| Herdr | 0.6.8 | 53.4 ms | 52.3 KiB |
| Zellij | 0.44.3 | 60.0 ms | 9.4 KiB |
| tmux | 3.6a | 116.3 ms | 66.2 KiB |

Herdr's workspace was created before timing. All tools were given the same pseudoterminal geometry
and were already started before timing. Zellij emitted the least client traffic; Fiber reached the
completion marker first for this high-scroll workload.

This benchmark rewards state coalescing: multiplexers do not need to transmit all 2 MiB to show the
final 80x24 state. It does not measure every important workload. Full comparisons must also include
key-to-PTY latency, sparse Neovim updates, mouse input, multiple panes, slow clients, large
scrollback, and memory use.

## Performance invariants

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
