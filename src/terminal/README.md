# Terminal adapter

Home of Lemma's only boundary to `libghostty-vt`.

Every live pane has one authoritative daemon-owned terminal. The adapter consumes PTY output, owns
canonical screen and scrollback state, captures terminal responses/effects, exposes bounded
Lemma-owned damage/cell/mode values to the renderer, and encodes application input from canonical
terminal modes.

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

`TerminalOptions::scrollback_bytes_max` is intentionally measured in bytes and is applied through
Ghostty's `GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES` option immediately after construction. Ghostty
prunes at page
granularity, so the configured byte value is an estimate rather than a strict retained-byte count.
Rows and bytes are not interchangeable, so no silent compatibility alias is provided.

Ghostty PagePool storage bypasses Lemma's C `QuotaAllocator`. Allocation statistics exposed by the
adapter therefore cover only routed C allocations and must not be described as total terminal
memory.
