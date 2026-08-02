# Renderer

Home of Lemma's daemon-owned ANSI compositor.

The renderer consumes canonical terminal damage, resolved topology, daemon-owned per-attachment view
state, status, overlays, and retained extension UI models. It clips regions, composes synchronized
frames, retains physical outer-terminal state, and emits bounded ANSI. Attach, window changes,
resize, lag recovery, and reconnect can invalidate retained state and force a complete redraw.

Rendering is synchronous, deterministic, allocation-bounded, and limited to affected terminals and
presentation regions. It does not poll descriptors, mutate topology, parse PTY streams, generate
terminal responses, or execute Lua.

A later native backend may consume replaceable Lemma-owned presentation snapshots/deltas derived
from the same canonical state. Such values are presentation, not a client terminal replica; native
rendering is not required for 1.0.
