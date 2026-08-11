# Protocol

This component owns Lemma's bounded private wire codecs. It does not open sockets, dispatch commands,
parse terminal output, render frames, or expose a public RPC.

The attached terminal path is private protocol 1.0. Both directions use a deterministic 16-byte
magic/version/kind/flags/length/sequence envelope. Its closed messages are hello, input, resize,
pane command, detach, complete ANSI render frame with full-redraw generation, and typed disconnect.
Every envelope and typed payload field is validated by bounded incremental decoders before core or
outer-terminal mutation. Render payloads are limited to 4 MiB; client input is limited to 8 KiB.

The daemon decoder owns 8,208 inline bytes. The client prepares one connection-lifetime 4,194,324-byte
RAII owner before terminal mutation and exposes only borrowed spans below it. Both support arbitrary
fragmentation, coalescing, and retry of an unconsumed message.

The isolated Lua host continues to use its independent bounded extension protocol in `extension.*`.
The older one-shot create/list/kill/shutdown control format remains an internal CLI setup path; it
cannot enter the versioned attached stream. No public automation, capture, or semantic RPC schema is
implemented here.

See [`docs/protocol.md`](../../docs/protocol.md) for the exact wire contract, validation order,
backpressure, redraw recovery, and terminal-cleanup guarantees.
