# Terminal adapter

Home of Lemma's only boundary to `libghostty-vt`.

Every live pane has one authoritative daemon-owned terminal. The adapter consumes PTY output, owns
canonical screen and scrollback state, owns the concrete session theme, captures terminal
responses/effects, exposes bounded Lemma-owned damage/cell/mode values to the renderer, encodes
application input and opaque paste from canonical terminal modes, and adapts Ghostty's viewport,
selection gestures, tracked active selection, formatting, and incremental compression. Literal
search traverses public grid references in bounded slices and retains no duplicate terminal grid or
result list. PTY-response overflow is a sticky integrity failure, and Kitty graphics remains disabled
until its bounded presentation path exists.

Ghostty headers, private enum values, allocator identities, pointers, and memory layouts never cross
this component or appear on the wire. `terminal_impl.hpp` contains the private handles; lifecycle,
effects, input, rendering, and selection/formatting live in their corresponding private translation
units behind the public `lemma::vt::Terminal` facade. The adapter does not own PTYs, child processes,
topology, client sockets, copy-mode policy, frame scheduling, or protocol state.

The retained checkpoint feasibility evidence documents a temporary reconstructive-VT prototype and
replica role. Deterministic parser, UTF-8, inactive-screen, and
history counterexamples caused a Stop result. The completed architecture review retained
server-rendered daemon authority, so the prototype and replica API were removed from the production
source tree.

## Scrollback unit contract

`TerminalOptions::scrollback_bytes_max` and optional `scrollback_lines_max` map independently to
Ghostty's byte and physical-line options immediately after construction. Ghostty prunes at page
granularity, so both values are estimates and the first reached limit drives pruning. Rows and bytes
are not interchangeable, so no silent compatibility alias is provided. The core observes Ghostty's
opaque activity token and performs bounded incremental compression only after the pane has been idle.

Ghostty PagePool storage bypasses Lemma's C `QuotaAllocator`. Allocation statistics exposed by the
adapter therefore cover only routed C allocations and must not be described as total terminal
memory.
