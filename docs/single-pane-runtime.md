# Runtime vertical slice

## Status

Fiber's end-to-end vertical slice has been migrated out of the former monolithic
`single_pane.cpp`. Workspaces now support bounded windows and split panes while retaining the
production component architecture. This document records implemented behavior; agreed foundation
decisions and explicitly open product questions are in
[`product-contract.md`](product-contract.md).

```text
apps/fiber/main.cpp
        |
        v
     app/run
      /   \
 client   daemon
             \
              core engine -> terminal adapter -> libghostty-vt
                   |
                   +------> renderer / platform / protocol
```

There is no temporary demo component or `app -> demo` dependency. Further mux work must build on
the core, client, daemon, protocol, and render boundaries rather than recreate a vertical-slice
monolith.

## Current ownership

### Application — `src/app/`

Parses commands and selects client or daemon operations. It contains the diagnostic `fiber demo`
command but no workspace runtime logic. `apps/fiber/main.cpp` only delegates to `fiber::app::run`.

### Client — `src/client/`

Owns the attached process side: raw-terminal setup/restoration, `SIGWINCH` observation, prefix
parsing, input/resize packet emission, daemon output forwarding, and detach behavior. It holds no
pane or terminal-emulator state.

### Daemon — `src/daemon/`

Owns the single per-user socket path, locking, stale-socket validation, daemonization, listener
lifetime, and cleanup. It creates and owns the listener and lends the descriptor to the core engine.
Workspace creation, lookup, listing, and removal are handled by the authoritative engine.

### Core — `src/core/`

Owns up to 64 running workspaces, 1,024 windows, and 4,096 panes in one reactor. Each workspace is
bounded to 16 windows and 64 panes distributed across those windows. Every pane owns one child
process, PTY, terminal, and resolved rectangle. A generationally identified window owns its split
tree and focus/zoom state. The workspace owns its ordered window slots, active-window selection,
attached daemon-side client descriptor, protocol-message state, frame scheduling, and backpressure
state. The reactor borrows the daemon listener and remains the sole owner of mutable workspace and
terminal state.

### Supporting components

- `src/platform/`: descriptor I/O, PTY/process operations, and terminal mode;
- `src/protocol/`: bounded packet encoding, prefix parsing, and incremental decoding;
- `src/render/`: retained frame buffers and partial nonblocking client writes;
- `src/terminal/`: the sole private `libghostty-vt` adapter;
- `src/extension/`: an isolated full-Lua host that sends transactional registrations over bounded
  IPC after loading the host machine's optional `init.lua`.

## Supported behavior

The runtime currently provides:

- up to 64 validated named workspaces in one per-user daemon;
- up to 16 windows and 64 shells, PTYs, and canonical Ghostty terminals per workspace;
- generational window IDs that reject stale slot references;
- one attached client plus independent workspace/window-list and kill control connections;
- tmux-compatible window create/cycle/select/kill and pane split/focus/close/zoom bindings;
- one bounded binary split tree per window, with one-cell pane separators;
- a centered, one-row window status with one-based numbers, focused-pane foreground process names,
  and bounded overflow;
- terminal resize propagation from resolved pane rectangles;
- bounded protocol and PTY read batches;
- terminal-generated PTY responses;
- dirty-row rendering and retained physical client state;
- bounded composition of validated pane rectangles into one synchronized outer-terminal frame;
- focused-pane cursor and outer-terminal mode ownership in the composition layer;
- a 2 ms frame-coalescing deadline;
- partial nonblocking live-frame writes;
- full visible-state reconstruction on reattach and active-window changes;
- PTY progress for inactive windows without rendering them;
- deterministic child, descriptor, socket, and lock cleanup.

## Current limitations

The architecture is migrated and the first window/split-pane behavior is implemented, with these
limitations:

- workspaces and panes do not yet use separate generational stores; windows use generational IDs
  within their owning workspace;
- only one client may attach at a time;
- the local protocol has no version or capability negotiation;
- listener acceptance and initial attach setup still use the vertical slice's simple policy;
- new workspaces inherit the daemon's original environment and working directory;
- the isolated Lua host can register a bounded generation, but command callbacks, snapshots, event
  delivery, rendered UI, process APIs, output subscriptions, and reload are not yet integrated;
- windows have numeric slots but no user-defined names or interactive rename prompt;
- windows cannot be linked across workspaces;
- pane ratios are fixed at equal halves and cannot yet be resized interactively;
- alternate tmux layouts, pane-number overlays, and per-client physical state are not yet
  implemented.

These are feature and runtime-hardening tasks, not reasons to reorganize the source tree again.

## Foundation sequence

The agreed next work is the extension and command foundation, without treating unresolved product
choices as committed release behavior:

1. Start and supervise one full-Lua host in a process isolated from the daemon.
2. Establish bounded, versioned, nonblocking registration IPC and transactional generations.
3. Represent existing topology and lifecycle changes as typed core commands with bounded arguments
   and typed results.
4. Route built-in keys, CLI operations, and extension requests through one semantic dispatcher.
5. Add asynchronous Lua command invocation, immutable snapshots, and bounded event delivery.
6. Install declarative Lua keymaps into C++ and retain validated status/sidebar surfaces for the C++
   renderer.
7. Add asynchronous process/timer APIs and explicit bounded pane-output subscriptions.
8. Implement replacement-host reload that preserves the old generation until the candidate commits.
9. Measure idle-host overhead, registration and command latency, event floods, blocked hosts, and
   output backpressure.
10. Generalize the client protocol for local and SSH operation after the shared command model is
    established.

Steps 1 and 2 now have an implementation slice: missing config activates an empty generation; valid
Lua can register commands, keymaps, subscriptions, and a bounded sidebar; malformed generations are
rejected; and host IPC is processed after mux-critical work. The later steps remain implementation
work, not behavior already claimed by the executable.

## Rules for contributors and agents

- Never move client raw-terminal state into the daemon or core.
- Never move socket naming, locks, or daemonization into the core.
- Never expose Ghostty headers outside `src/terminal/terminal.cpp`.
- Do not let client or extension work block PTY progress.
- Preserve bounds when generalizing a single object into an arena.
- Add state transitions through typed commands instead of direct cross-component mutation.
- Keep structural refactors separate from new mux behavior.
- Update this document when ownership or a runtime invariant changes.
