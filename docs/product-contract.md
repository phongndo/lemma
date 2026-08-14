# Lemma product contract

## Product identity

Lemma is an open-source, self-hosted terminal multiplexer for fast, reliable, composable sessions without a hosted service.

One per-user daemon owns long-lived terminal sessions. Humans, scripts, Lua extensions, remote shells, and coding agents should operate the same semantic model rather than receiving separate feature-specific control paths.

Lemma's standard installation should be useful without configuration or extensions. Extensibility augments a complete mux; it does not substitute for basic lifecycle, layout, input, history, copy, presentation, diagnostics, or compatibility behavior.

## Vocabulary

A **Session** is the named attachment and process-lifecycle boundary within a running daemon. It owns an ordered set of tabs and survives the loss of an attached client.

A **Tab** belongs to one session and owns a pane layout, focus, and zoom state.

A **Pane** belongs to one tab and represents one PTY-backed process surface.

An **Attachment** is a user's or actor's semantic view/control relationship with a session. It is not the session and is not its transport connection.

The kernel hierarchy is:

```text
Session -> Tab -> Pane
```

A space, workspace, project, worktree, task, or agent run is not inherently a kernel object. Extensions compose those concepts from stable Session, Tab, and Pane IDs. A concept enters the kernel only if essential correctness, process, terminal, or security state cannot be represented through IDs, commands, snapshots, events, and policy outside it.

## Daemon and lifecycle behavior

- One daemon per user is authoritative for sessions, child processes, PTYs, and terminal state.
- Detaching or losing a client does not end pane processes.
- Reattachment reconstructs visible state from daemon authority.
- Explicitly killing a pane/session or shutting down the daemon is destructive and distinct from detach.
- Daemon crash, forced kill, user logout, and host reboot are not durability guarantees unless a later contract explicitly adds one.
- Lemma must not call detach continuity “persistence across daemon failure.”
- Endpoint ownership and permissions prevent another local user from controlling the daemon.

Plain `lemma` means “enter the literal `default` session”: create and attach if missing, attach if detached, and fail visibly if already controlled under a single-controller policy. Explicit create/start/attach commands retain distinct behavior.

## Launch context

Session creation captures a bounded, validated absolute working directory and environment snapshot. Attaching later does not mutate that launch context implicitly.

A new tab or split should use a documented deterministic cwd rule. Safely observed focused-pane cwd may be preferred; the session creation directory is the fallback. Missing or inaccessible directories produce an observable fallback rather than undefined process behavior.

The account login shell is the default process. Arbitrary commands require a typed launch contract that includes cwd, environment, identity, exit reason, and error behavior rather than ad hoc shell strings.

## Human and machine semantics

Keyboard, mouse, CLI, Lua, and agents converge on typed commands, stable targets, typed results, and the same policy checks.

- Every core workflow is keyboard-complete.
- Mouse is a first-class spatial input method, not accidental raw-byte forwarding.
- Equivalent keyboard and mouse actions dispatch the same semantic command.
- Application input is distinct from mux commands and is encoded from canonical terminal modes.
- Paste is a bounded opaque input event and cannot become prefix commands.
- Human-readable CLI output remains the default; machine surfaces use explicit typed/machine-readable contracts.
- Every supported human mutation has an automation equivalent or a documented exclusion.

The default key vocabulary follows familiar tmux conventions, including `C-b` as prefix, while configuration may replace bindings without creating another mutation path.

## Terminal and presentation behavior

Ghostty owns terminal semantics; Lemma owns mux and product semantics. The daemon parses each PTY stream once and remains authoritative for screen state, history, modes, and terminal responses.

The standard client is thin: it captures physical input, transports bounded messages, writes presentation, and restores the outer terminal. Attach, resize, tab changes, and lag recovery rebuild from daemon authority. A slow client may be repaired or disconnected but cannot stop PTY progress.

Server-rendered ANSI is a valid production presentation, not temporary scaffolding. A future native presentation is optional and must consume replaceable, non-authoritative presentation values. Client PTY replay and reconstructive terminal checkpoints are not product requirements.

Child-visible terminal identity must be truthful. Unsupported graphics or protocols are unadvertised or explicitly rejected; advertised behavior may not be silently discarded. Clipboard, notification, file, and similar side effects follow bounded explicit security policy.

## Copy, search, and history

Copy mode is attachment behavior over canonical Ghostty history:

- PTY parsing continues while the attachment browses older content;
- viewport, copy cursor, search query, and authorization are attachment policy;
- Ghostty owns history, reflow, graphemes, tracked references, selection primitives, and terminal formatting;
- search and formatting are bounded and do not create another canonical grid; and
- user-initiated copy authorization is distinct from application-originated clipboard requests.

Keyboard and mouse selection should share one semantic model. Wrapped lines, wide cells, graphemes, and combining characters follow terminal semantics rather than hand-built text reconstruction.

## Configuration and extensions

Configuration is Lua running as trusted user code in an isolated Lemma-managed process. A missing configuration selects useful built-in defaults.

The extension contract consists of bounded serializable values, stable IDs, typed command requests/results, immutable snapshots/events, and declarative UI models. It does not expose pointers, descriptors, Ghostty values, or mutable daemon arenas. There is no native C++ plugin ABI.

Configuration generations are transactional: validate a complete candidate, commit atomically, and preserve the prior valid generation on failure. A blocked, crashed, or over-quota extension cannot block PTY parsing, input, rendering, or pane processes.

Projects, worktrees, agent status, sidebars, and workflow orchestration are good extension responsibilities. Correctness- and latency-sensitive terminal, process, layout, command, and resource mechanisms remain native.

## Local and remote boundary

Lemma is self-hosted. The baseline remote model is ordinary SSH to a host running its own Lemma daemon:

```sh
ssh -t HOST lemma
```

The remote host owns its processes, sessions, configuration, permissions, and lifecycle. Transport loss behaves like client loss. Live cross-host process migration, hosted control planes, accounts, browser/mobile clients, and transparent configuration synchronization are not product promises.

A dedicated remote transport may later carry the same semantic and presentation contracts, but it must not create a second core or weaken authority and permission boundaries.

## Deliberate non-goals

Unless this contract changes, Lemma does not require:

- compatibility with every tmux command or edge case;
- a hosted service;
- native C++ plugins;
- client-side terminal authority or raw PTY replay;
- terminal checkpoint compatibility across Ghostty versions;
- process survival across daemon death or reboot;
- workspaces/tasks/agent runs as mandatory kernel containers;
- multiplayer or multiple controllers without explicit attachment and permission policy; or
- universal performance superiority claims.

Product changes require an explicit contract update.
