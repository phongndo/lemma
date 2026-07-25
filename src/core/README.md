# Core

Home of Fiber's authoritative mux engine and dense state.

The current engine owns up to 64 named workspaces, 1,024 windows, and 4,096 panes in one reactor.
Each workspace is bounded to 16 windows and 64 panes distributed across them. Every pane has one
child process, PTY, terminal adapter, and resolved surface. Each generationally identified window
owns its binary split tree and focus/zoom state. Each workspace owns its window order and active
selection, attached client, input decoder, bounded status model/signature, damage schedule, and
frame deadline. The engine borrows the daemon's listener but does not own socket
paths, locks, daemonization, or terminal-client raw mode.

As the current workspace, window, pane, and client values move into generational stores, this
component will add typed commands/events, bounded work queues, and a generalized backpressure
policy. Generalized task, run, and view entities are not part of the agreed foundation; introduce
new authoritative entities only when implemented behavior proves they are necessary, and keep them
dense and data-oriented rather than creating independently allocated service objects.

The core may orchestrate platform, terminal, protocol, and render interfaces. It must not know about
CLI syntax, Lua stack details, Unix socket naming policy, or Ghostty C types.
