# Renderer

Home of Lemma's client-side presentation backends.

The target renderer consumes terminal replicas, logical topology values, retained extension UI
models, and client-local view state. It resolves physical rectangles, clips viewports, composes
borders/status/overlays, retains backend physical state, and renders either bounded ANSI for an
existing outer terminal or native surfaces. Both backends consume the same checkpoint/event replica
model.

Rendering is synchronous, deterministic, allocation-bounded, and limited to affected replicas and
presentation regions. It does not poll protocol descriptors, mutate authoritative topology, parse PTY
streams, generate terminal responses, or execute extensions.

The current implementation is a daemon-driven ANSI pane compositor: the engine supplies canonical
terminals and resolved rectangles, and the renderer produces synchronized attached-client frames.
That code remains a tested migration asset. The replication foundation moves it behind the smart
client, changes its inputs to client-owned replicas and semantic topology, then removes daemon ANSI
output. A temporary old/new endpoint overlap is migration scaffolding, not a permanent dual renderer
architecture.
