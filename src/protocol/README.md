# Protocol

Home of bounded messages between Lemma clients, the daemon, and the extension host. This component
owns schemas, limits, versions, capabilities, encoding, and incremental decoding.

The production client protocol is bidirectional and server-rendered. It carries hello/mismatch,
attach/control requests, typed commands/results/errors, stable IDs, ordered key/text/paste/focus/
mouse/resize input, bounded complete ANSI render frames, full-redraw generations, and explicit client
effects where policy requires. This attached-client framing remains private and version-coupled.

A separate public semantic schema is shared by JSON CLI, Lua, and the same-user automation socket. It
carries actors/requests, stable IDs, commands/results/errors, capabilities, snapshots, bounded events,
and launch/capture/wait/cancel operations. Agents use that schema rather than render frames.

Protocol code does not open sockets, discover spaces, dispatch commands, parse terminal bytes,
hit-test layouts, or render frames. Every length, enum, version, capability, identifier, and generation is
validated before authoritative mutation. The wire never contains Ghostty values or private layouts.

The present `lemma-v8` format is unversioned and sends unframed daemon ANSI. It is the tested
migration baseline. The rolling `TODO.md` backlog replaces it incrementally while preserving daemon
terminal and presentation ownership. See `docs/protocol.md`.
