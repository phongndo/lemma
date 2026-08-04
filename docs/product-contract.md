# Lemma foundation decisions

## Status

This document records decisions explicitly agreed for Lemma's foundation and the 1.0 product
boundary. A recorded decision is not a claim that the behavior is implemented; current behavior
remains audited in `current-capabilities.md`. Later copy-mode refinements, package discovery, and the
final remote UX may evolve only through an explicit contract update.

The current executable's ownership is described in
[`single-pane-runtime.md`](single-pane-runtime.md), and its audited user-facing behavior is
inventoried in [`current-capabilities.md`](current-capabilities.md). Required day-to-day mux behavior
and its completion bar are defined in [`daily-driver-contract.md`](daily-driver-contract.md);
outcome and priority guidance is defined in [`roadmap.md`](roadmap.md).

## Product direction

Lemma is an open-source, self-hosted terminal multiplexer built like infrastructure: fast, reliable,
and programmable without requiring a hosted service. Its typed command model is intended to let
people, scripts, remote clients, and coding agents operate the same long-lived sessions while the
latency-sensitive runtime remains bounded and independently operable.

One per-user daemon owns sessions, tabs, panes, child processes, PTYs, and canonical terminal
state. A process continues when no terminal client is attached, so an unattached session or pane
is the initial background-execution model. Generalized task, run, and view entities are not required
for the foundation.

Remote-first initially means operating a Lemma daemon on another machine through ordinary SSH:
create processes, inspect state, attach, detach, and manage sessions through the same semantic API
used locally. Ordinary SSH terminal operation and machine-readable commands are the 1.0 baseline; a
custom `lemma connect` SSH-stdio bridge is deferred beyond 1.0. Live cross-host process migration is
not a current promise.

Lemma's pillars are:

1. **performance:** C++ owns every PTY, canonical terminal, and damage-rendering hot path; thin
   clients never duplicate terminal parsing and slow presentation cannot block PTY progress;
2. **strong foundation:** mutable state has one owner, every boundary is bounded, and client or
   extension failure cannot end pane processes;
3. **first-class input:** keyboard and mouse are co-equal ways to operate mux state and terminal
   applications; and
4. **extensibility:** configuration and extensions use one powerful Lua API over typed values.

## Core vocabulary

A **session** is Lemma's durable attachment and process-lifecycle boundary. It owns an ordered set
of tabs, survives detach, and is the top-level object addressed by `SessionId`.

A **tab** belongs to exactly one session and owns a pane split tree, layout, focus, and zoom. A
**pane** belongs to exactly one tab and owns one PTY-backed process surface and canonical terminal.
The canonical kernel hierarchy is therefore `Session → Tab → Pane`.

A **space**, workspace, project, worktree, task, or agent run is intentionally not a kernel object.
Extensions may associate those meanings with named collections of stable `SessionId` and `TabId`
values, provide commands and retained views for them, and persist their own policy state. This keeps
workflow policy replaceable and avoids a mandatory container between every session and tab. Such a
concept enters the kernel only if it eventually owns essential process, terminal, security, or
correctness state that cannot be represented through stable IDs, metadata, commands, events, and
views.

The pre-1.0 `Space*`/`Window*` C++ and protocol vocabulary is renamed to `Session*`/`Tab*` without
compatibility aliases; downstream embedders must update before the vocabulary becomes stable.

## Attached-client and presentation contract

Lemma has one production attached-client architecture through 1.0. The daemon owns canonical
`libghostty-vt` state, logical and physical layout, process/PTY lifetime, terminal responses,
application-input encoding, per-attachment view state, and ANSI composition. A thin client owns its
connection, physical input decoding, outer-terminal writes, and complete terminal restoration. It
owns no VT parser or terminal replica.

Attach, reconnect, active-tab changes, resize, and lag recovery reconstruct a complete visible
frame from current daemon authority. Live output uses bounded ordered render frames. If one client
cannot make bounded write progress, canonical damage continues to represent the newest state; after
the blocked frame completes the daemon forces a full redraw, or disconnects the client at its
progress deadline. Pane processes and unrelated work continue.

The retained [`terminal-checkpoint-feasibility.md`](terminal-checkpoint-feasibility.md) evidence
records the Stop result that rejected smart replicas and selected server-rendered authority. A future native client,
if justified after 1.0, consumes replaceable presentation snapshots/deltas derived from canonical
state rather than replaying PTY bytes.

The daemon remains the only authority for PTY responses and policy side effects. The 1.0
one-client-per-session rule also selects canonical PTY dimensions. Multiple viewers/controllers
require explicit per-attachment state and control policy later; they do not change terminal ownership.

## Input contract

Keyboard operation remains complete: every core session, tab, pane, copy, and configuration
workflow must be usable without a mouse. Mouse support is nevertheless a primary interaction model,
not optional raw-byte forwarding. Thin clients perform bounded physical input decoding; the daemon
owns presentation hit testing, status interaction, per-attachment selection/scrolling, and ratio
mutation. Equivalent keyboard and mouse actions dispatch the same typed commands.

When a terminal application requests mouse tracking, the client sends bounded outer-terminal mouse
values. The daemon hit-tests its resolved layout, derives a stable `PaneId` and pane-local coordinates,
validates them, and encodes the event through the canonical terminal adapter's active modes. A
configurable modifier lets a user override application capture for mux selection and navigation.
Cell-based SGR mouse input is the required baseline; additional encodings may be supported through
the terminal adapter. The client must restore outer-terminal keyboard, focus, paste, mouse,
synchronized-update, and alternate-screen modes on every normal, error, signal, and disconnect path.

The current runtime implements keyboard prefix commands but does not yet implement this mouse path.
The versioned client protocol must represent typed key, text/paste, focus, resize, and mouse values
without losing their input order.

## 1.0 product contract

These choices define required behavior for the server-rendered daily-driver and 1.0 implementation;
until then the capability audit continues to label gaps as partial or absent.

### Plain invocation and default session

Plain `lemma` means “enter my default session.” It uses the literal session name `default`:

1. if `default` does not exist, create it and attach;
2. if it exists detached, attach;
3. if it is already attached, fail visibly and nonzero rather than selecting another session; and
4. if daemon startup, session creation, or attach fails, report that stage and preserve any
   session that was successfully created.

Explicit `lemma new NAME`, `start`, and `attach` keep their distinct behavior. Lemma does not guess a
session based on recency because that makes scripts and first-session instructions unpredictable.

### Pane cwd and environment

The first pane in a session starts in the invoking client's current working directory, transported
as a validated bounded absolute path. A split or new tab starts in the focused pane's current
working directory when the platform can inspect it safely; otherwise it falls back to the
session-creation directory. A missing or inaccessible directory falls back to the invoking user's
home and produces an observable warning.

Session creation captures a bounded environment snapshot from the invoking client. All panes in
that session inherit the snapshot. Attaching later does not mutate it implicitly. A future explicit
refresh operation may update an allowlisted set, but 1.0 has no ambient attach-time refresh. Invalid
names, embedded NULs, and values outside the protocol bounds are rejected before session mutation.

Lemma 1.0 launches the account login shell only. Per-pane custom commands are deferred until command,
cwd, environment, and exit reporting can share one typed launch contract.

### Lifecycle and durability guarantees

Guarantees are deliberately separate:

| Event | 1.0 guarantee |
| --- | --- |
| Normal detach | Pane processes, topology, terminal state, and scrollback continue while the daemon lives. |
| Client EOF/crash/terminal loss | Same process-continuity guarantee as detach; the outer terminal is restored where the client can still execute cleanup. |
| User logout | No survival guarantee. Lemma may continue where the operating system preserves the per-user daemon, but 1.0 does not install a lingering service. |
| Daemon crash or forced kill | No process, topology, terminal-state, or scrollback survival guarantee. |
| Host reboot | No survival guarantee. |
| Explicit daemon shutdown | Ends owned pane processes after an explicit warning/confirmation contract; it is not equivalent to detach. |

Lemma must never describe ordinary detach continuity as persistence across daemon failure or reboot.
Signal-complete outer-terminal restoration remains required even though daemon-owned process
persistence is not.

### Supported platforms

The initial supported and release-tested matrix is:

- macOS 14 or newer on Apple Silicon;
- macOS 15 or newer on Intel while GitHub supplies that runner;
- Ubuntu 24.04 LTS on x86_64; and
- Ubuntu 24.04 LTS on arm64.

A supported platform receives release artifacts, scheduled CI, installation testing, and
release-blocking fixes for Lemma regressions. Other current glibc Linux distributions and newer macOS
versions are best effort until added to that matrix. The matrix may shrink only through a documented
release-policy change.

### Name

The project keeps the **Lemma** name for 1.0. The executable and package namespace remain `lemma`.
The established project identity and pre-alpha migration cost do not currently justify a rename.
Package-registry and legal screening must be repeated before publishing artifacts; a concrete
conflict is a release blocker handled by an explicit rename decision rather than a reason to leave
the current name perpetually undecided.

### Default keyboard, copy, and mouse behavior

- The default prefix remains `C-b`; `C-b C-b` sends a literal prefix.
- Copy mode enters with `C-b [` and defaults to vi-style movement, `/` and `?` search, `Space` to
  begin selection, `Enter` to copy, and `q`/`Escape` to leave. Configuration may select another key
  table later.
- Lemma mouse operation is enabled by default once the complete typed mouse path ships.
- Holding `Shift` overrides application mouse capture for Lemma focus, selection, scrolling, and
  separator/status interaction.
- Every core workflow remains keyboard-complete, and equivalent keyboard/mouse mutations dispatch
  the same semantic command.

Until copy mode and typed mouse input are implemented and tested, the current release must not imply
that these defaults are active.

### Automation and AI-agent boundary

Machine-readable CLI output selected with `--format=json` is the first public automation surface;
human-readable output remains the default. Before 1.0, Lemma also exposes a versioned same-user
semantic socket for efficient scripts and AI agents. It is separate from the private attached-client
render/input protocol and contains only stable IDs, typed commands/results/errors, capabilities,
snapshots, bounded events/output observations, deadlines, cancellation, and request/idempotency
identity.

Every supported human semantic mutation has an automation equivalent or a documented exclusion.
Agents can discover the schema/context, launch commands with cwd/environment, mutate topology, send
typed input, capture bounded terminal content, wait for output/exit, inspect results, and cancel work
without screen scraping. Output/event loss is explicit and repairable through bounded capture or
snapshots. Local agents initially have the invoking user's permissions; remote permissions and
multiple-controller policy remain later decisions.

Provider-specific detection, working/blocked/done views, worktrees, and orchestration remain
extensions rather than core agent entities. Lemma ships a maintained agent `SKILL.md` and at least one
first-party agent-observer extension to prove the API.

### 1.0 client and remote boundary

The 1.0 client is a thin outer-terminal adapter over the versioned server-rendered protocol. It
decodes bounded physical input, writes daemon-produced ANSI frames, and guarantees cleanup; the
daemon remains the only terminal and presentation authority. A native renderer is explicitly not a
1.0 requirement.

The supported remote baseline is ordinary SSH terminal operation (`ssh -t HOST lemma`) plus
machine-readable commands invoked over ordinary SSH. Transport loss has the same process-continuity
behavior as local client loss. A custom `lemma connect` SSH-stdio transport, configuration
synchronization, multiplayer, and agent permissions remain later product work.

## Programmable mux standard layer

Lemma follows a Pi-like product shape: a small high-performance C++ mux kernel, one typed semantic
API, a complete tmux-like standard experience, and replaceable Lua workflow/UI policy. Correctness-
and latency-sensitive PTY, terminal, render, input, history, layout, store, command, and protocol
mechanisms remain C++. Lua may compose commands, bindings, layouts, startup behavior, status,
sidebars, overlays, notifications, projects, and agent workflows through bounded values.

The shipped standard layer uses the same commands/settings/declarative UI available to user packages,
while a minimal C++ fallback keeps pane processes and essential operation available if Lua fails.
Local versioned packages/modules are a 1.0 requirement; marketplace discovery is not.

## C++ and Lua boundary

The daemon, control CLI, and thin attached client remain C++ and may ship as one executable with
distinct process roles. A persistent Lua 5.5 host runs in a separate Lemma-managed process.
Configuration is entirely Lua, beginning at the host machine's `~/.config/lemma/init.lua` (or
`$XDG_CONFIG_HOME/lemma/init.lua`). The remote daemon uses the configuration installed on the remote
host for the initial remote implementation.

Lua code is trusted user code with normal user permissions. It may use the filesystem, network,
processes, standard Lua libraries, and native Lua modules. Project-local Lua is not loaded
automatically in the first release. Declared permissions may provide provenance and warnings before
Lemma attempts enforceable sandboxing.

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
PTY read -> authoritative Ghostty parse -> bounded damage composition -> client frame
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

- settings through `lemma.setup`;
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

The extension foundation includes process isolation, framed registration messages, transactional
generation activation, daemon-side supervision, command invocation, snapshots, event delivery,
rendered sidebars, process APIs, output streaming, and reload. These remain one plugin architecture.

## Still open beyond the 1.0 boundary

These do not block the 1.0 release contract but require later product decisions:

- PTY-only versus additional pipe-backed background jobs;
- exact clipboard provider and bounded OSC 52 policy beyond the selected copy-mode defaults;
- marketplace discovery and installation UX beyond local versioned packages;
- config synchronization between local and remote hosts;
- the exact first remote CLI syntax and capability set.
