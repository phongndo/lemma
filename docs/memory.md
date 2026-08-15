# Memory evidence

Configured maxima are safety limits, not acceptable baseline cost.

The working model is:

```text
M(N, H) = M_base + N * M_pane + M_history(H) + M_fragmentation
```

The canonical reproduction is:

```sh
scripts/ci/memory extended
```

It builds release with tracing disabled, emits compiler record layouts, records stripped binary/dependency sizes, runs Lemma/tmux 1/4/16/64-pane profiles, measures detached/attached lifecycle states, populates history, and performs 100 create/attach/split/close/detach/kill cycles.

The evidence below was collected on the Mac16,5 Apple M4 Max 64-GiB host in August 2026. Raw reports are named `f3-memory-*` and `f4-final-memory-*` under the untracked `build/release/` evidence directory.

## Dominant-owner audit

The pre-change owner census changed measured owners in descending order rather than optimizing small fields first:

| Rank | Pre-change owner | Byte census | Measured one-pane daemon effect |
| ---: | --- | ---: | ---: |
| 1 | 128 eager pending connections | 128 x 135,304 = 17,318,912 B | 24,952,832 -> 7,716,864 B |
| 2 | One eager frame per session | 4,194,304 B/session | 7,716,864 -> 3,719,168 B |
| 3 | Always-present extension runtime | 189,272 B plus host process | removed from no-config path |
| 4 | Live terminal/pane state | about 0.37–0.38 MiB marginal daemon RSS/pane | retained as canonical live state |

Pending connections are now lazy slot-owned objects. Frame storage exists only while attached and is sized from viewport geometry. No extension runtime or Lua process exists without explicit configuration.

## Current owner census

| Owner | Current storage/lifetime | Bound or measured size | Allocation/failure behavior |
| --- | --- | ---: | --- |
| Session store | fixed reactor table | 1,032 B table; up to 64 sessions | live sessions are individually allocated; create failure rejects only the new session |
| Session | one owner per live session | 93,000 B inline in the recorded layout | contains bounded launch context, tabs, one current attachment runtime, copy state, trace, and scheduling |
| Tab | one owner per live tab | 3,600 B | allocated on create; failure preserves existing topology |
| Pane and inline PaneRuntime | one owner pair per live pane | 224 B combined; 208 B is PaneRuntime | PTY/process/terminal creation completes before topology commit |
| Ghostty routed state | terminal quota allocator | 10,376 B at create; 116,729 B after first render; 64 MiB default maximum | lazy; quota failure is typed; PagePool is accounted separately |
| Physical cell hashes | terminal adapter | 8 B/cell; 15,360 B at 80x24; 8,000,000 B hard maximum | replacement prepared on create/resize |
| Scrollback | Ghostty PagePool | 10,000-B default logical byte quota; 1,000,000-B hard byte/optional line limits | page-granular; PagePool bypasses the routed allocator |
| Pane PTY write queue | lazy per pane | 32 B inline; commonly 4,096 B after first packet; 1,114,112-B pane max; 128 MiB aggregate | grows transactionally, reuses drained capacity, rejects/backpressures on quota exhaustion |
| Daemon client-input decoder | one inline per session/pending attach | 8,208 B ordinary storage; at most 1,048,592 B after a valid large-paste envelope; less than 65 MiB across 64 sessions | pending handshakes cannot trigger expansion; expanded storage is released after the packet drains or the client detaches |
| Attached frame | session-owned only while attached | 0 detached; 679,936 B at 80x24; 35,204,096 B at 500x200; 64 MiB ceiling | grows only at attach/resize; failed growth preserves prior state; composition/flush borrow spans |
| Client host-input capture | client-owned while attached | about 2 MiB heap for one opaque paste plus classified output; less than 128 KiB per-read event batch | prepared before terminal mutation; fragmentation state is bounded and malformed input is preserved without unbounded retention |
| Client server decoder | client-owned while attached | 4,194,324-B virtual bound | allocated before terminal mode mutation; pages touched only by received bytes |
| Pending connection | one lazy live setup | 143,544 B each; 128 slots | allocation failure closes only the new descriptor |
| Extension daemon state | optional | 0 without config; 189,272 B with config | startup-owned; IPC storage is fixed-capacity |
| Extension host | isolated process | 78,728-B fixed host state plus 16 MiB Lua quota | host failure cannot retain daemon work or stop panes |
| Reactor scratch | automatic bounded arrays | about 244 KiB daemon parent frame plus 64 KiB PTY read buffer; attached-client input classification adds less than 128 KiB per read | no retained frame or terminal history on the stack |

The session layout number is a compiler-layout observation, not a target architecture endorsement. The current `Session` combines semantic and attachment runtime state; [`architecture.md`](architecture.md) describes the intended ownership split.

## Resident profile

Five-sample 80x24 measurements used identical shell and completion semantics:

| Panes | Lemma idle tree / daemon | tmux idle tree / daemon | Lemma active tree / daemon |
| ---: | ---: | ---: | ---: |
| 1 | 8.83 / 3.19 MiB | 9.92 / 4.12 MiB | 8.02 / 3.94 MiB |
| 4 | 18.94 / 4.48 MiB | 18.83 / 4.23 MiB | 18.14 / 5.25 MiB |
| 16 | 58.66 / 8.95 MiB | 54.33 / 4.47 MiB | 57.86 / 9.72 MiB |
| 64 | 217.11 / 26.42 MiB | 195.58 / 4.75 MiB | 216.31 / 27.20 MiB |

Shell descendants dominate the larger process trees and are similar between muxes. Lemma's measured idle daemon marginal was 0.372 MiB/pane from 4 to 16 panes and 0.368 MiB/pane from 16 to 64 panes.

One cold detached session increased daemon RSS by 1.016 MiB. Attachment added 0.156 MiB. After detach, a 0.156-MiB delta remained from canonical Ghostty/render allocator pages; the frame owner itself returned to zero capacity.

## History and allocator interpretation

After 25,000 rows, one-pane daemon RSS rose by 786,432 B and tree RSS by 802,816 B while retained logical history remained under the configured 10,000-byte quota. This is not contradictory: Ghostty PagePool page granularity, active pages, and allocator retention are resident costs outside Lemma's routed C-allocation counter.

Terminal allocation statistics therefore describe only allocations routed through Lemma's Ghostty C allocator. They must never be presented as total terminal memory.

## Churn and release size

A 100-cycle create/attach/split-to-four/close-to-one/detach/kill workload warmed to 4,997,120 B daemon RSS and remained exactly flat for its final 21 samples. Every cycle reclaimed sessions, children, and descriptors. This supports a stable plateau for that workload and duration, not a proof against all leaks.

The measured release executable was 2,259,016 B unstripped and 1,972,872 B after `strip -x`. Ghostty, Lua, and zstd were statically linked; system `libc++` and `libSystem` remained dynamic dependencies.

Memory changes should rerun the owner census and resident workloads. Replacing a large hard maximum with another eager pool is not an improvement merely because the type layout became smaller.
