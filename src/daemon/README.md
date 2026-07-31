# Daemon

Home of per-user daemon lifecycle and transport policy.

**Owns:** immutable runtime endpoint selection, the per-user endpoint and lock, local listener
lifecycle, foreground serving/double-fork daemonization, socket cleanup, shutdown orchestration, and
transport bootstrap. The target SSH-stdio path carries the same application protocol and lends its
validated connection lifecycle to the core rather than creating a remote core.

**Does not own:** workspace state, terminal state, PTY scheduling, rendering algorithms, protocol
parsing internals, or raw client-terminal state. It creates one listener and lends it to the core
engine, which owns every workspace plus bounded incremental accepted-connection state in the
single-writer reactor.
