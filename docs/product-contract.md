# Fiber foundation decisions

## Status

This document records decisions explicitly agreed for Fiber's foundation. It is not a complete
first-release feature contract. CLI defaults, copy-mode behavior, durability beyond daemon lifetime,
and the final remote UX remain open and must not be inferred from this document.

The current executable is described in [`single-pane-runtime.md`](single-pane-runtime.md).

## Product direction

Fiber is a performant terminal process runner and multiplexer. One per-user daemon owns workspaces,
windows, panes, child processes, PTYs, and canonical terminal state. A process continues when no
terminal client is attached, so an unattached workspace or pane is the initial background-execution
model. Generalized task, run, and view entities are not required for the foundation.

Remote-first initially means operating a Fiber daemon on another machine: create processes, inspect
state, attach, detach, and manage workspaces through the same semantic API used locally. SSH stdio is
the preferred first remote transport. Live cross-host process migration is not a current promise.

Fiber's pillars are:

1. **performance:** C++ owns every PTY, terminal, layout, composition, and output hot path;
2. **strong foundation:** mutable state has one owner, every boundary is bounded, and extension
   failure cannot end pane processes; and
3. **extensibility:** configuration and extensions use one powerful Lua API over typed values.

## C++ and Lua boundary

The daemon and disposable CLI/client remain C++ and ship as one executable. A persistent Lua 5.5
host runs in a separate Fiber-managed process. Configuration is entirely Lua, beginning at the
host machine's `~/.config/fiber/init.lua` (or `$XDG_CONFIG_HOME/fiber/init.lua`). The remote daemon
uses the configuration installed on the remote host for the initial remote implementation.

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
PTY read -> Ghostty parse -> damage -> compose -> encode -> client write
```

Extension work is deferred until after ready PTYs, client input, and due frames. The daemon never
waits synchronously for Lua. Events and pane-output subscriptions are bounded, batched, and subject
to coalescing or dropping; loss is observable and can be repaired from a snapshot. C++ retains the
last validated extension UI surface and renders it without invoking Lua.

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

## Still open

The following require explicit decisions before a complete first-release contract exists:

- plain `fiber` startup and default workspace behavior;
- exact process cwd and environment inheritance;
- PTY-only versus additional pipe-backed background jobs;
- detach, logout, daemon-restart, and reboot durability guarantees;
- copy mode, pane resizing, and default bindings;
- the public automation/RPC presentation;
- package discovery and installation;
- config synchronization between local and remote hosts; and
- the exact first remote CLI syntax and capability set.
