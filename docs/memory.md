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
| Semantic Session | Core-owned per live session | 71,152 B inline in the recorded layout | contains bounded launch context, Session-scoped pane slots, tab slots, and the 136-B tab-order permutation; no descriptor, decoder, terminal, render buffer, clock, or teardown I/O |
| Attachment | Core-owned one-per-session value | 712 B | contains stable IDs, bounded committed/draft copy-search queries, a 96-B bounded rename editor, explicit copy viewport and phase policy, and generation-safe pane or divider mouse capture identity; ordinary wheel scrolling stays in Ghostty; no independent allocation or duplicate divider coordinate |
| AttachmentRuntime | Runtime-owned one-per-session value | 9,048 B | owns connection, decoder, frame/output progress, runtime copy continuation, bounded pending routed input/client-work state, backpressure, and teardown; live divider resize retains no runtime geometry or deadline |
| Runtime session record | one stable aggregate allocation per live session | 81,776 B including Session, Attachment, InputRouter state, AttachmentRuntime, terminal theme, and connection generation | preserves direct addresses; each Attachment adds only bounded context and key-ownership state |
| Compiled input map | process-shared immutable value | 3,592 B for the complete 16-context/128-binding capacity | includes per-context legacy trigger masks so ordinary byte runs avoid per-byte binding search; no per-Attachment copy |
| Tab | one owner per live tab | 2,648 B | includes the 2,540-B fixed-capacity split tree and a 64-byte bounded title override; Session ownership removes the former per-Tab pane-slot array |
| Semantic Pane | Core-owned per live or held pane | 48 B | contains Session-scoped generational identity, owning TabId, committed geometry, indirect launch argv, exit policy, and committed process outcome; staged creation publishes it only with a prepared runtime counterpart |
| PaneRuntime | Runtime-owned per live or held pane | 232 B plus owned terminal/queue allocations | owns PTY/process/terminal, scheduling state, observed pre-commit child outcome, and its configured scrollback reservation; held exit closes the PTY but retains the canonical terminal until Core closes the pane |
| PaneRuntime store | one daemon runtime index plus one lazy table per live session | 528 B fixed; 1,040 B per session containing runtimes | direct `SessionId/PaneId` addresses avoid presentation-derived runtime lookup; the store owns the 3.2-GB configured scrollback reservation budget; a session table allocates before first pair publication and disappears with its last runtime |
| Ghostty routed state | terminal quota allocator | 12,228 B at create; 171,203 B after first render; 64 MiB default maximum | lazy; quota failure is typed; PagePool is accounted separately |
| Physical cell hashes | terminal adapter | 8 B/cell; 15,360 B at 80x24; 8,000,000 B hard maximum | create allocates the active extent; growth prepares a geometrically bounded replacement before Ghostty mutation, while subsequent resize reuses retained capacity |
| Scrollback | Ghostty PagePool | 50,000,000-B default/per-pane hard byte limit; optional 1,000,000-line hard limit; 3.2-GB daemon configured-capacity reservation | page-granular and lazy; PagePool bypasses the routed allocator; pane publication rejects when the Runtime-owned aggregate reservation is exhausted |
| Pane launch argv | optional semantic Pane owner | 0 for the login-shell default; exact retained payload up to 65,535 B for an explicit initial command | allocated only during staged explicit launch and released with the pane; held exit retains it with the semantic pane |
| Pane PTY write queue | lazy per pane | 32 B inline; commonly 4,096 B after first packet; 1,114,112-B pane max; 128 MiB aggregate | grows transactionally, reuses drained capacity, rejects/backpressures on quota exhaustion |
| Daemon client-input decoder | one inline per session/pending attach | 8,208 B ordinary storage; at most 1,048,592 B after a valid large-paste envelope; less than 65 MiB across 64 sessions | pending handshakes cannot trigger expansion; expanded storage is released after the packet drains or the client detaches |
| Attached frame | AttachmentRuntime-owned only while attached | 0 detached; 679,936 B at 80x24; 35,204,096 B at 500x200; 64 MiB ceiling | grows only at attach/resize; failed growth preserves prior state; composition/flush borrow spans |
| Client host-input capture | client-owned while attached | about 2 MiB heap for one opaque paste plus classified output; less than 128 KiB per-read event batch | prepared before terminal mutation; fragmentation state is bounded and malformed input is preserved without unbounded retention |
| Client server decoder | client-owned while attached | 4,194,324-B virtual bound | allocated before terminal mode mutation; pages touched only by received bytes |
| Procedure frontend | transient CLI process only | 1 MiB input, 4,096 JSON values, 64 actions, and at most 64 captured control responses | actions execute sequentially and release with the CLI; no procedure document, DOM, result reference, or captured text is retained by the daemon |
| Pending connection | one lazy live setup | 143,824 B base; validated launch setup may additionally retain exact environment and argv payloads up to 65,535 B each; 128 slots | the shared 65,535-B field also bounds one automation control payload; payload allocation is cold and released with the setup; allocation failure rejects only that connection |
| Extension daemon state | optional | 0 without config; 189,272 B with config | startup-owned; IPC storage is fixed-capacity |
| Extension host | isolated process | 78,728-B fixed host state plus 16 MiB Lua quota | host failure cannot retain daemon work or stop panes |
| Reactor scratch | automatic bounded arrays | about 244 KiB daemon parent frame plus 64 KiB PTY read buffer; attached-client input classification adds less than 128 KiB per read | no retained frame or terminal history on the stack |

The layout numbers are compiler observations. The aggregate record is a locality decision rather than shared authority: each mutable subobject has one owner and distinct teardown semantics.

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

## Isolated workspace and named-session scaling

Twenty one-second samples measured 1, 4, and 16 detached units with one live shell each. A Lemma session, tmux session, Zellij session, and Herdr workspace are the normal logical workspace units. Herdr named sessions are also shown separately because each starts another server and provides a stronger process/fault boundary. Reports are `perf-current4-*-session-profiles-20.json` and `perf-current4-herdr-workspace-profiles-20.json`.

| Subject and unit model | 1 unit tree RSS | 4 units | 16 units | Authority RSS at 16 | Authority wakeups p95 / s at 16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lemma logical sessions, one daemon | 6.11 MiB | 16.17 MiB | 55.47 MiB | 8.70 MiB | 0 |
| tmux sessions, one server | 6.91 MiB | 15.69 MiB | 51.06 MiB | 4.33 MiB | 0 |
| Zellij named sessions, one server each | 80.20 MiB | 322.89 MiB | 1,299.77 MiB | 1,253.48 MiB | 69 |
| Herdr workspaces, one server | 22.16 MiB | 31.64 MiB | 71.00 MiB | 24.50 MiB | 48 |
| Herdr named sessions, one server each | 21.91 MiB | 87.23 MiB | 350.30 MiB | 303.83 MiB | 203 |

Shell descendants contributed about 2.9 MiB per unit across subjects. From 4 to 16 logical units, authority RSS grew about 0.355 MiB per Lemma session, 0.028 MiB per tmux session, and 0.374 MiB per Herdr workspace. Herdr's normal one-server workspace model therefore has a similar marginal terminal/workspace cost to Lemma but a much larger base and more idle wakeups. Herdr's named-session mode and Zellij trade substantially higher per-unit cost for separate server processes.

Lemma's logical sessions are not process-isolation boundaries: one daemon crash still affects all of them. Their measured isolation is bounded reactor progress and independent lifecycle, not OS-level fault or security containment.

## History and allocator interpretation

Under the former 10,000-byte default, 25,000 input rows increased one-pane daemon RSS by 786,432 B and tree RSS by 802,816 B while pruning almost all logical history. With the 50,000,000-byte default, the direct terminal owner census retains 24,977 of 25,000 rows; routed Ghostty allocations rise only from 171,203 B after initial render to 190,041 B because PagePool remains outside that allocator.

The post-change five-sample release profile measured the 25,000-row retained-history workload at a daemon/tree RSS increase of 18,350,080/18,481,152 B over the empty attached session. This is the expected cost of retaining useful history rather than the previous single-page behavior.

Terminal allocation statistics therefore describe only allocations routed through Lemma's Ghostty C allocator. They must never be presented as total terminal memory.

## Churn and release size

The post-change 100-cycle create/attach/split-to-four/close-to-one/detach/kill workload warmed to 5,718,016 B daemon RSS and remained exactly flat for its final 25 samples. Every cycle reclaimed sessions, children, descriptors, and configured scrollback reservations. This supports a stable plateau for that workload and duration, not a proof against all leaks.

The measured release executable was 2,259,016 B unstripped and 1,972,872 B after `strip -x`. Ghostty, Lua, and zstd were statically linked; system `libc++` and `libSystem` remained dynamic dependencies.

Memory changes should rerun the owner census and resident workloads. Replacing a large hard maximum with another eager pool is not an improvement merely because the type layout became smaller.
