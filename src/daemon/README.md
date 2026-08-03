# Daemon

Home of per-user daemon lifecycle and transport policy.

**Owns:** immutable runtime endpoint selection, the per-user endpoint and lock, local listener
lifecycle, foreground serving/double-fork daemonization, socket cleanup, shutdown orchestration, and
transport bootstrap. The 1.0 remote baseline runs the normal client or CLI on the remote host over
ordinary SSH. A custom SSH-stdio bridge is deferred beyond 1.0; if added later, it carries the same
application protocol and lends its validated connection lifecycle to the core rather than creating a
remote core.

**Does not own:** space state, terminal state, PTY scheduling, rendering algorithms, protocol
parsing internals, or raw client-terminal state. It creates one listener and lends it to the core
engine, which owns every space plus bounded incremental accepted-connection state in the
single-writer reactor.
