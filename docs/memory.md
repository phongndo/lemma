# Memory ownership and F3/F4 evidence

Lemma treats configured maxima as safety limits, not acceptable resident cost. The working model is:

```text
M(N, H) = M_base + N * M_pane + M_history(H) + M_fragmentation
```

The canonical reproduction is:

```sh
scripts/ci/memory extended
```

It performs a release build with tracing disabled, emits compiler record layouts, records stripped
binary/dependency sizes, runs identical Lemma/tmux P1/P4/P16/PMAX profiles, measures empty/detached/
attached lifecycle states, populates terminal history, and completes 100 create/attach/split/close/
detach/kill cycles. The F3 baseline files remain under `build/release/f3-memory-*`; F4's complete
rerun is retained under `build/release/f4-final-memory-*`. The owner ranking and history analysis
below are from commit `ce1173c0ab08b5de8ea2b7499bd06ce4090087e7` with the documented F3 worktree.
The exact layout census and final profile/lifecycle values were refreshed for F4 at pinned parent
`185c395500a0c90cb3031200166df904de5ff433`. Both ran on the Mac16,5 Apple M4 Max 64-GiB host on
August 10, 2026.

## Evidence-first owner ranking

Before production memory code changed, five dedicated samples were retained as
`f3-baseline-ce1173c-{lemma,tmux}-profiles-5.json`. Compiler layouts were retained as
`f3-baseline-ce1173c-engine-record-layouts.txt`. The measured dominant owners were changed one at a
time:

| Rank | Pre-F3 owner | Byte census | Measured P1 daemon effect |
|---:|---|---:|---:|
| 1 | 128 eager pending-connection objects | 128 x 135,304 = 17,318,912 B | 24,952,832 -> 7,716,864 B (-17,235,968 B) |
| 2 | one eager frame per session | 4,194,304 B/session | 7,716,864 -> 3,719,168 B (-3,997,696 B) |
| 3 | always-present extension runtime | 189,272 B plus host process | smaller than profile page variance; removed from the no-config path |
| 4 | terminal/pane state | about 0.37-0.38 MiB marginal daemon RSS/pane | retained because it is live canonical state |

This ranking used resident deltas, not maxima. In particular, PTY queues have a large hard bound but
were not baseline owners and were not replaced by an eager pool.

## Byte-level ownership census

Exact inline sizes come from Clang `-fdump-record-layouts` through
`benchmarks/ownership_census.py`. Dynamic current values are for an 80x24 shell after its initial
full render. “Touched” describes expected page behavior rather than virtual reservation.

| Owner | Storage/lifetime | Min / current / maximum bytes | Allocation and release | Failure and page behavior | Reactor allocator work |
|---|---|---:|---|---|---|
| Session slot table | fixed automatic reactor owner | 1,032 / 1,032 / 1,032 | reactor entry/exit | infallible; eagerly touched | none |
| Session | one `unique_ptr` per live session | 93,000 inline each | create / session reclaim | `make_unique` failure rejects create; fixed members are eagerly initialized | create only |
| Session launch context | inline in `Session` | 69,704 included above | create / session reclaim | bounded name, cwd, and 65,535-B environment; preserves launch semantics | create only |
| Client decoder | inline in `Session` | 8,232 included above | session create/reclaim | fixed 8,208-B framed parser storage, no allocation | none |
| Attached-client server decoder | one RAII owner in the thin client | 0 detached; 4,194,324-byte virtual bound while attached | before handshake / client exit | allocation failure precedes raw/alternate-screen mutation; for-overwrite pages are touched only by received complete frames | outside daemon reactor; no growth after setup |
| Emergency termios restorer | one dormant forked helper while a client is in raw mode | P1 child RSS marginal 1,130,496 B; zero CPU in the final idle median | raw entry / client cleanup | fork/pipe/open failure aborts attach and restores synchronously; control-only child exits with its parent and never renders or mutates mux state | outside daemon reactor; sleeps until signal cleanup |
| Command trace | inline in `Session` | 14,336 included above | session create/reclaim | fixed 256-entry ring, no allocation | none |
| Tab | one `unique_ptr` per live tab | 3,600 each | tab create / close | allocation failure leaves prior topology valid | create only |
| Pane shell owner | one `unique_ptr` per live pane | 160 plus terminal state | pane create / close | shell/PTY/terminal creation completes before topology commit | create only |
| Terminal adapter | `Terminal::Impl` RAII owner | 81,768 inline | pane create / close | `make_unique` failure rejects pane; eagerly initialized | create only |
| Ghostty routed state | terminal quota allocator | 10,376 at create; 116,729 after first render; 64 MiB default maximum | terminal create/render/history / pane close | lazy Ghostty allocations; quota failure is typed; pages touched on use | initial render and quota-owned history growth; steady render measured allocation-free |
| Physical cell hashes | terminal-owned array | 8 B/cell; 15,360 at 80x24; 8,000,000 hard maximum | pane create or resize / replacement or close | replacement is prepared before commit; zero initialized | create/resize only |
| Scrollback page list | Ghostty terminal owner | active-screen minimum; 10,000-B default logical history quota; 1,000,000-B hard quota | grows/prunes on PTY output / pane close | page-granular and lazy; content is pruned under owner quota; allocator/page retention is measured separately | quota-owned PTY history exception |
| PTY write queue | one `PanePtyWriteQueue` per pane | 32 inline + 0 dynamic; typically 4,096 after first packet; 1,114,112 per-pane maximum | grows on accepted input/terminal response; releases at pane close or explicit clear | checked replacement before commit; 128-MiB daemon aggregate; exhausted quota backpressures without mutation | rare quota-owned growth on input/response; flush never allocates; drained capacity is reused |
| Frame buffer | 32-B `FrameBuffer` in each session; dynamic only while attached | 0 detached; 679,936 at 80x24; 35,204,096 at the declared 500×200 geometry; 64 MiB transaction hard maximum | attach/resize / detach | checked `4 KiB + 352 B/cell`, with a 64 KiB floor and 64 MiB ceiling; failed growth preserves old storage; an in-flight prefix is copied before commit; allocation is for-overwrite and pages are touched by composition; transport exposes at most one 4 MiB chunk at a time | attach/resize only; composition and flush use spans |
| Client frame progress | inline in `Session` | 344 | session lifetime | fixed framed-header, typed-disconnect, offsets, and deadlines; no allocation | none |
| Pending slot table | 128 fixed `unique_ptr` slots plus persistent generations | 1,536 / 1,536 / 1,536 | reactor entry/exit | infallible pointer/generation tables, eagerly touched; generations survive slot churn | none |
| Pending connection | one RAII object per accepted setup | 0 when idle; 143,544 per live setup; 18,373,632 aggregate maximum | accept / close or attach handoff | allocation failure closes only the new descriptor; object includes the 8,232-B attach decoder, 65,535-B control field, and 65,552-B output storage; pages are touched for that live setup only | accept/control setup only; control flush never allocates |
| Extension daemon state | one optional `ExtensionRuntime` | 0 without config; 189,272 with config | daemon startup when config exists / shutdown | allocation failure fails startup before reactor mutation | no foundational-path owner; IPC processing is fixed-capacity |
| Extension host state | isolated process stack plus quota-owned Lua state | 78,728 fixed `HostState`; 16-MiB Lua allocation maximum when opted in | config-host start / process exit | failed Lua growth preserves accounting and reports a config memory error; host failure cannot retain daemon work or stop panes; no host exists when config is absent | outside daemon reactor |
| Reactor descriptor scratch | bounded automatic storage | about 243,816 parent-frame bytes | reactor entry/exit | fixed arrays for 4,290 descriptors/owners, 64 frame targets, and 4,096 writable pane pointers | none |

`f3-memory-terminal-ownership.json` records the terminal numbers directly: initial full rendering
raised Ghostty-routed ownership from 10,376 B/13 allocations to 116,729 B/38 allocations; a further
25,000 rows caused no routed allocation, retained 746 scrollback rows, and remained under the
10,000-byte logical history quota. Ghostty page-pool mappings bypass that routed counter, so the
separate process workload is authoritative for resident history cost.

## Stack and automatic-storage bound

F3 adds no recursive path and no large automatic buffer. It replaces the old 17.3-MiB pending table
and 189-KiB unconditional extension object with 1.5-KiB and 8-B automatic owner tables. The existing
reactor parent frame has approximately 244 KiB of fixed descriptor/owner/queue-pointer arrays. Its
largest nested scratch path is the existing 64-KiB PTY read buffer, for an estimated C++ high-water
of about 310 KiB plus ordinary call frames. Composition's bounded pane/status views are smaller.
No retained frame, terminal state, history, or pending payload is placed on the stack.

## Final resident model

Five dedicated final samples used identical 80x24 shells and completion semantics:

| Profile | Lemma idle tree / daemon | tmux idle tree / daemon | Lemma active tree / daemon |
|---|---:|---:|---:|
| P1 | 8.83 / 3.19 MiB | 9.92 / 4.12 MiB | 8.02 / 3.94 MiB |
| P4 | 18.94 / 4.48 MiB | 18.83 / 4.23 MiB | 18.14 / 5.25 MiB |
| P16 | 58.66 / 8.95 MiB | 54.33 / 4.47 MiB | 57.86 / 9.72 MiB |
| PMAX | 217.11 / 26.42 MiB | 195.58 / 4.75 MiB | 216.31 / 27.20 MiB |

The shell descendants dominate large process trees and are nearly identical between muxes. Lemma's
idle daemon marginal from P4 to P16 was 0.372 MiB/pane and from P16 to PMAX was 0.368 MiB/pane. The
component workload measured a 1.016-MiB daemon delta from empty daemon to one cold detached session,
a 0.156-MiB attach delta, and a 0.156-MiB post-detach retained delta caused by canonical Ghostty
render state/allocator pages, not retained frame ownership. The frame owner itself returns to zero
capacity on detach.

P1 idle fell from 28.30 MiB pre-F3 to 8.83 MiB. After F4's bidirectional decoders and dormant
signal-restoration helper, the final Lemma/tmux ratio is 0.890, below the 1.5 completion limit without
excluding the shell, helper, or attached client. The client's 4 MiB virtual decoder bound remains
lazy: attached-client RSS was 1.62 MiB in the final P1 median.

## History and allocator retention

After 25,000 rows, P1 daemon RSS rose by 786,432 B and process-tree RSS by 802,816 B. This resident
page cost is intentionally reported rather than equated to the 10,000-byte logical quota. The quota
bounds retained content; Ghostty's active pages, page granularity, and allocator retention account for
the larger RSS delta.

The 100-cycle lifecycle workload returned to a stable plateau. Daemon RSS warmed from 3,801,088 B,
reached 4,997,120 B at cycle 80, and remained exactly 4,997,120 B for the final 21 cycles; the final
25-sample range was 163,840 B and the final 21-sample range was zero. Every cycle completed create, attach, split to four panes, close to one,
detach, kill, and child/session reclamation.

## Executable and process contribution

The release `lemma` executable was 2,259,016 B unstripped and 1,972,872 B after `strip -x`. Its only
dynamic dependencies were system `libc++` and `libSystem`; Ghostty, Lua, and zstd were statically
linked. The pinned tmux executable was 1,126,944 B. No extension host contributes to the foundational
no-config process tree. With an explicit config, its 78,728-B fixed host state and Lua runtime are a
separate process and are reported as `extension_host` by resource workloads that enable it.
