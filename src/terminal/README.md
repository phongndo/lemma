# Terminal adapter

Home of Lemma's only boundary to `libghostty-vt`.

Every live pane has one authoritative daemon-owned terminal. The adapter consumes PTY output, owns
canonical screen and scrollback state, captures terminal responses/effects, exposes bounded
Lemma-owned damage/cell/mode values to the renderer, and encodes application input from canonical
terminal modes.

Ghostty headers, private enum values, allocator identities, pointers, and memory layouts never cross
this component or appear on the wire. The adapter does not own PTYs, child processes, topology,
client sockets, copy-mode policy, frame scheduling, or protocol state.

The retained checkpoint feasibility evidence documents a temporary reconstructive-VT prototype and
replica role. Deterministic parser, UTF-8, inactive-screen, and
history counterexamples caused a Stop result. The completed architecture review retained
server-rendered daemon authority, so the prototype and replica API were removed from the production
source tree.

## Scrollback unit contract

`TerminalOptions::scrollback_bytes_max` is intentionally measured in bytes. The pinned Ghostty C
header names `max_scrollback` in lines, but its implementation applies that value as a byte limit in
the page allocator. Lemma previously exposed `scrollback_rows_max`; correcting the name and unit is
an intentional pre-1.0 source API break for embedders. Rows and bytes are not interchangeable, so no
silent compatibility alias is provided.

Ghostty PagePool storage bypasses Lemma's C `QuotaAllocator`. Allocation statistics exposed by the
adapter therefore cover only routed C allocations and must not be described as total terminal
memory.
