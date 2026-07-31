# Core

Home of Fiber's authoritative mux engine and dense state.

The current engine owns up to 64 named workspaces, 1,024 windows, and 4,096 panes in one reactor.
Each workspace is bounded to 16 windows and 64 panes. Every pane owns one child process, PTY,
canonical terminal adapter, resolved logical surface, and ordered bounded PTY write queue. Each
window owns a generational ID, binary split tree, focus, and zoom state. Each workspace owns window
order/selection, attached-client state, status state, and the current transitional frame schedule.

The target core additionally owns dense authoritative workspace/pane/client stores, one monotonically
ordered terminal-event sequence per pane, bounded client acknowledgement/resume state, checkpoint and
history scheduling, controller/permission policy, and semantic topology/UI distribution. It retains
only bounded event tails; a lagging client resets from a fresh checkpoint instead of blocking PTYs or
creating an unbounded raw-output log.

The public `fiber/command.hpp` model provides bounded command kinds, origins, generational-ID targets,
typed results, and a validating dispatcher. All client, CLI, extension, remote, and agent mutations
converge on that executor. Client presentation hit testing emits stable targets; physical client
rectangles never become core identities.

The core may orchestrate platform, terminal, protocol, and extension interfaces. It does not know CLI
syntax, Lua stack details, Unix socket naming policy, client rendering algorithms, or Ghostty C types.
Generalized task/run/view entities remain out of scope; client-local replica/view state is expendable
client data, not a new authoritative service graph.
