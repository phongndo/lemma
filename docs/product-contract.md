# Fiber foundation decisions

## Status

This document records decisions explicitly agreed for Fiber's foundation and the v0.1 alpha product
boundary. A recorded decision is not a claim that the behavior is implemented; current behavior
remains audited in `current-capabilities.md`. Later copy-mode refinements, package discovery, and the
final remote UX may evolve only through an explicit contract update.

The current executable's ownership is described in
[`single-pane-runtime.md`](single-pane-runtime.md), and its audited user-facing behavior is
inventoried in [`current-capabilities.md`](current-capabilities.md). Required day-to-day mux behavior
and its completion bar are defined in [`daily-driver-contract.md`](daily-driver-contract.md);
milestone order is defined in [`roadmap.md`](roadmap.md).

## Product direction

Fiber is an open-source, self-hosted terminal multiplexer built like infrastructure: fast, reliable,
and programmable without requiring a hosted service. Its typed command model is intended to let
people, scripts, remote clients, and coding agents operate the same long-lived sessions while the
latency-sensitive runtime remains bounded and independently operable.

One per-user daemon owns workspaces, windows, panes, child processes, PTYs, and canonical terminal
state. A process continues when no terminal client is attached, so an unattached workspace or pane
is the initial background-execution model. Generalized task, run, and view entities are not required
for the foundation.

Remote-first initially means operating a Fiber daemon on another machine: create processes, inspect
state, attach, detach, and manage workspaces through the same semantic API used locally. SSH stdio is
the preferred first remote transport. Live cross-host process migration is not a current promise.

Fiber's pillars are:

1. **performance:** C++ owns every PTY and authoritative terminal hot path; smart clients replay
   ordered terminal events and own presentation rather than waiting for daemon ANSI composition;
2. **strong foundation:** mutable state has one owner, every boundary is bounded, and client or
   extension failure cannot end pane processes;
3. **first-class input:** keyboard and mouse are co-equal ways to operate mux state and terminal
   applications; and
4. **extensibility:** configuration and extensions use one powerful Lua API over typed values.

## Replicated-terminal client contract

Fiber has one target attached-client architecture. The daemon owns canonical `libghostty-vt` state,
logical topology, process/PTY lifetime, terminal responses, and application-input encoding. A smart
client imports a bounded versioned terminal checkpoint at sequence `N`, becomes ready, then applies
every ordered output, resize, reset, and exit event after `N`. Recent-to-oldest scrollback may hydrate
after readiness.

Checkpoint plus event tail is the attachment, live-update, reconnect, and lag-recovery mechanism for
both local Unix sockets and SSH stdio. A client may resume from acknowledged sequences only when the
complete tail is retained and all versions match; otherwise it resets from a fresh checkpoint. A
slow client never causes unbounded event retention or blocks PTY progress.

The daemon does not maintain permanent raw, cell-delta, and ANSI output architectures. ANSI
compatibility is a smart-client presentation backend over local replicas. The primary future native
client renders the same replicas directly. Checkpoints use a Fiber-owned format and never expose
private Ghostty memory layouts. The required export/import capability must pass the feasibility gate
in [`.plan/002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md)
before the generalized wire format is frozen.

The daemon remains the only authority for PTY responses and policy side effects. Replica processing
must suppress those responses. One controlling client selects canonical PTY dimensions; viewers use
that grid until control is transferred rather than independently resizing the same terminal state.

## Input contract

Keyboard operation remains complete: every core workspace, window, pane, copy, and configuration
workflow must be usable without a mouse. Mouse support is nevertheless a primary interaction model,
not optional raw-byte forwarding. Smart clients own bounded input decoding, client-presentation hit
testing, status interaction, selection, scrolling, and drag gestures. Equivalent keyboard and mouse
mux actions dispatch the same typed commands rather than maintaining separate mutation paths.

When a terminal application requests mouse tracking, the client sends a stable `PaneId` plus
pane-local coordinates and bounded typed action data. The daemon validates the target and encodes the
event through the authoritative terminal adapter's active modes. Fiber-owned chrome remains under
the client's control, and a configurable modifier lets a user override application capture for mux
selection and navigation. Cell-based SGR mouse input is the required baseline; additional encodings
may be supported through the terminal adapter. A compatibility client must restore outer-terminal
keyboard, focus, paste, mouse, synchronized-update, and alternate-screen modes on every normal,
error, signal, and disconnect path.

The current runtime implements keyboard prefix commands but does not yet implement this mouse path.
The versioned client protocol must represent typed key, text/paste, focus, resize, and mouse values
without losing their input order.

## v0.1 alpha product contract

These choices close the first-release decision gate. They define required behavior for subsequent P1
and P2 implementation; until then the capability audit must continue to label gaps as partial or
absent.

### Plain invocation and default workspace

Plain `fiber` means “enter my default workspace.” It uses the literal workspace name `default`:

1. if `default` does not exist, create it and attach;
2. if it exists detached, attach;
3. if it is already attached, fail visibly and nonzero rather than selecting another workspace; and
4. if daemon startup, workspace creation, or attach fails, report that stage and preserve any
   workspace that was successfully created.

Explicit `fiber new NAME`, `start`, and `attach` keep their distinct behavior. Fiber does not guess a
workspace based on recency because that makes scripts and first-session instructions unpredictable.

### Pane cwd and environment

The first pane in a workspace starts in the invoking client's current working directory, transported
as a validated bounded absolute path. A split or new window starts in the focused pane's current
working directory when the platform can inspect it safely; otherwise it falls back to the
workspace-creation directory. A missing or inaccessible directory falls back to the invoking user's
home and produces an observable warning.

Workspace creation captures a bounded environment snapshot from the invoking client. All panes in
that workspace inherit the snapshot. Attaching later does not mutate it implicitly. A future explicit
refresh operation may update an allowlisted set, but v0.1 has no ambient attach-time refresh. Invalid
names, embedded NULs, and values outside the protocol bounds are rejected before workspace mutation.

v0.1 launches the account login shell only. Per-pane custom commands are deferred until command,
cwd, environment, and exit reporting can share one typed launch contract.

### Lifecycle and durability guarantees

Guarantees are deliberately separate:

| Event | v0.1 guarantee |
| --- | --- |
| Normal detach | Pane processes, topology, terminal state, and scrollback continue while the daemon lives. |
| Client EOF/crash/terminal loss | Same process-continuity guarantee as detach; the outer terminal is restored where the client can still execute cleanup. |
| User logout | No survival guarantee. Fiber may continue where the operating system preserves the per-user daemon, but v0.1 does not install a lingering service. |
| Daemon crash or forced kill | No process, topology, terminal-state, or scrollback survival guarantee. |
| Host reboot | No survival guarantee. |
| Explicit daemon shutdown | Ends owned pane processes after an explicit warning/confirmation contract; it is not equivalent to detach. |

Fiber must never describe ordinary detach continuity as persistence across daemon failure or reboot.
Signal-complete outer-terminal restoration remains required even though daemon-owned process
persistence is not.

### Supported platforms

The initial supported and release-tested matrix is:

- macOS 14 or newer on Apple Silicon;
- macOS 15 or newer on Intel while GitHub supplies that runner;
- Ubuntu 24.04 LTS on x86_64; and
- Ubuntu 24.04 LTS on arm64.

A supported platform receives release artifacts, scheduled CI, installation testing, and
release-blocking fixes for Fiber regressions. Other current glibc Linux distributions and newer macOS
versions are best effort until added to that matrix. The matrix may shrink only through a documented
release-policy change.

### Name

The project keeps the **Fiber** name for v0.1. The executable and package namespace remain `fiber`.
The established project identity and pre-alpha migration cost do not currently justify a rename.
Package-registry and legal screening must be repeated before publishing artifacts; a concrete
conflict is a release blocker handled by an explicit rename decision rather than a reason to leave
the current name perpetually undecided.

### Default keyboard, copy, and mouse behavior

- The default prefix remains `C-b`; `C-b C-b` sends a literal prefix.
- Copy mode enters with `C-b [` and defaults to vi-style movement, `/` and `?` search, `Space` to
  begin selection, `Enter` to copy, and `q`/`Escape` to leave. Configuration may select another key
  table later.
- Fiber mouse operation is enabled by default once the complete typed mouse path ships.
- Holding `Shift` overrides application mouse capture for Fiber focus, selection, scrolling, and
  separator/status interaction.
- Every core workflow remains keyboard-complete, and equivalent keyboard/mouse mutations dispatch
  the same semantic command.

Until copy mode and typed mouse input are implemented and tested, the current release must not imply
that these defaults are active.

### First automation boundary

The first public automation surface is machine-readable CLI output, selected explicitly with
`--format=json`; human-readable output remains the default. The CLI uses the versioned local semantic
protocol internally, but raw local RPC is not a supported public API in v0.1. A documented local RPC
API becomes public with stable IDs, snapshots, typed results, cancellation, and compatibility policy
in the programmable milestone. This keeps the first automation contract scriptable without freezing
the initial transport framing as a public API.

### v0.1 client and remote boundary

The v0.1 alpha proves the final checkpoint/event architecture with a smart compatibility client that
renders client-side replicas into an outer terminal. The old daemon-rendered ANSI endpoint may exist
only during migration and is removed before the replication-foundation exit gate. A native renderer
is required before Fiber claims the complete native performance direction and is targeted by v0.2.

The same application protocol must pass an SSH-stdio transport proof in v0.1, including attach,
progressive history, reconnect, forced checkpoint recovery, slow-link bounds, and mismatch behavior.
This does not freeze exact remote CLI syntax, configuration synchronization, multiplayer, or agent
permissions in v0.1.

## C++ and Lua boundary

The daemon, control CLI, and smart attached client remain C++ and may ship as one executable with
distinct process roles. A persistent Lua 5.5 host runs in a separate Fiber-managed process.
Configuration is entirely Lua, beginning at the host machine's `~/.config/fiber/init.lua` (or
`$XDG_CONFIG_HOME/fiber/init.lua`). The remote daemon uses the configuration installed on the remote
host for the initial remote implementation.

Lua code is trusted user code with normal user permissions. It may use the filesystem, network,
processes, standard Lua libraries, and native Lua modules. Project-local Lua is not loaded
automatically in the first release. Declared permissions may provide provenance and warnings before
Fiber attempts enforceable sandboxing.

The C++ daemon never exposes pointers, descriptors, Ghostty values, or mutable arenas to Lua. The
public extension contract contains only bounded serializable values, stable IDs, typed command
requests and results, immutable snapshots and events, and declarative UI surfaces. There is no
native C++ plugin ABI.

## IPC performance contract

The Lua host communicates with the daemon over a nonblocking, length-framed, versioned local socket.
A typed Lua API hides the transport. The same semantic command model is shared by built-in keys,
CLI operations, remote operations, agents, and extensions.

IPC is never part of the terminal hot path:

```text
PTY read -> sequence event -> authoritative Ghostty parse -> bounded client synchronization
```

Extension work is deferred until after ready PTYs, client input, and due synchronization work. The
daemon never waits synchronously for Lua. Events and pane-output subscriptions are bounded, batched,
and subject to coalescing or dropping; loss is observable and can be repaired from a semantic
snapshot. C++ retains the last validated extension UI model and distributes it to clients, which
render it without invoking Lua.

Built-in key bindings dispatch C++ commands without IPC. Declarative Lua keymaps are installed into
C++ state. Only commands implemented by Lua require asynchronous host invocation.

## Lua host lifecycle

There is initially one Lua host per daemon. All user modules share it; a bad extension may disrupt
other extensions but cannot disrupt the daemon or panes.

A configuration generation is transactional:

1. a fresh candidate collects settings, commands, keymaps, subscriptions, and UI declarations;
2. every value and bound is validated;
3. a complete candidate is committed atomically; and
4. a failed candidate leaves the previous generation active.

Missing `init.lua` selects built-in defaults. An initial load error leaves the daemon operational and
must be observable. If the host disconnects or crashes, extension callback commands become
unavailable, extension UI is removed, pane processes continue, and the daemon restarts the host with
bounded backoff. A later reload implementation must activate a replacement only after successful
validation.

## First-release Lua foundation

The approved minimum capability surface is:

- settings through `fiber.setup`;
- dynamic commands;
- declarative keymaps;
- bounded event subscriptions;
- immutable state snapshots;
- typed core-command dispatch;
- asynchronous process spawning and timers;
- notifications and status segments;
- at least one first-class sidebar surface;
- explicit bounded pane-output subscriptions; and
- transactional hot reload.

The first implementation slice establishes process isolation, framed registration messages,
transactional generation activation, and daemon-side supervision. Command invocation, snapshots,
event delivery, rendered sidebars, process APIs, output streaming, and reload are subsequent slices
of this same foundation—not a separate plugin architecture.

## Still open beyond the v0.1 boundary

These do not block the v0.1 decision gate but require later milestone decisions:

- PTY-only versus additional pipe-backed background jobs;
- exact clipboard provider and bounded OSC 52 policy beyond the selected copy-mode defaults;
- package discovery and installation for extensions;
- config synchronization between local and remote hosts;
- the public local RPC lifecycle and compatibility policy; and
- the exact first remote CLI syntax and capability set.
