# Protocol

Home of bounded messages between Fiber clients, the daemon, and the extension host. This component
owns schemas, limits, versions, capabilities, encoding, and incremental decoding.

The target client protocol is bidirectional and transport-independent. It carries typed
commands/results/errors, topology snapshots/deltas, terminal checkpoints, ordered pane
output/resize/reset/exit events, progressive history ranges, ready/acknowledgement/resume/reset
transitions, and ordered key/text/paste/focus/mouse/resize input. Local Unix sockets and SSH stdio use
the same application values and state machines.

It does not open sockets, discover workspaces, dispatch core commands, parse terminal bytes, import
terminal state, or render presentation. Every length, enum, version, capability, identifier, sequence,
and range is validated before entering authoritative or replica state. Checkpoint encoding is
Fiber-owned and cannot expose Ghostty private layouts.

The present one-client-per-workspace `fiber-v8` format is unversioned and sends daemon-rendered ANSI.
It remains a protected migration baseline only. After the smart-client cutover, production attachment
uses checkpoint plus ordered event tail and the old endpoint is removed. See `docs/protocol.md`,
`.plan/002-terminal-checkpoint-feasibility.md`, and
`.plan/003-replicated-terminal-foundation.md`.
