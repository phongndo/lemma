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

There is no temporary demo component or `app -> demo` dependency. This diagram describes current
implementation, not the selected target ownership: the checkpointed architecture adds client-owned
terminal replicas and moves presentation behind the smart client. Migration must build on the core,
client, daemon, protocol, terminal, and render boundaries rather than recreate a vertical-slice
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
- keyboard prefix commands are implemented, but first-class mouse decoding, hit testing, application
  pass-through, selection, scrolling, and drag resizing are not;
- the local protocol has no version or capability negotiation and still sends unframed daemon ANSI;
- new workspaces inherit the daemon's original environment and working directory;
- the isolated Lua host can register a bounded generation, but command callbacks, snapshots, event
  delivery, rendered UI, process APIs, output subscriptions, and reload are not yet integrated;
- windows have numeric slots but no user-defined names or interactive rename prompt;
- windows cannot be linked across workspaces;
- pane ratios are fixed at equal halves and cannot yet be resized interactively;
- alternate tmux layouts, pane-number overlays, and per-client physical state are not yet
  implemented;
- the client has no terminal replicas, checkpoint importer, event sequence, acknowledgement, or
  progressive history state;
- `libghostty-vt` has no Fiber-exposed portable checkpoint export/import contract; and
- daemon-to-client output is composed ANSI rather than the selected checkpoint/event protocol.

The server-rendered runtime remains the process-tested migration baseline. The selected architecture
changes attached-output and presentation ownership deliberately; it does not justify dissolving the
existing subsystem boundaries or weakening P0 invariants.

## Migration sequence

1. Pass or stop [`.plan/002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md):
   complete state inventory, portable export/import, checkpoint-plus-tail equivalence, side-effect
   suppression, progressive-history model, and resource evidence.
2. Move workspaces, panes, and clients into authoritative generational stores.
3. Add the bounded versioned topology/checkpoint/event/input protocol with explicit sequence and
   resynchronization semantics.
4. Build a one-pane smart client with a replica terminal and the existing ANSI presentation backend.
5. Add bounded acknowledgement, reconnect, forced fresh-checkpoint recovery, and history hydration.
6. Replicate logical topology and move multi-pane composition/status/overlays into the client.
7. Prove the same application protocol over SSH stdio under shaped links.
8. Cut over production attachment and remove daemon-to-attached-client composed ANSI.
9. Continue typed input, native presentation, mouse, copy/search/selection, and programmability on
   that single architecture.

The isolated Lua host, transactional registrations, and typed commands remain valid foundation.
Existing attached-client pane/window actions, detach, and CLI workspace stops already pass through
one validating dispatcher. Later extension callbacks and retained UI models must integrate after the
replication foundation; declarative UI is distributed to clients rather than synchronously rendered
by Lua or the daemon.

## Rules for contributors and agents

- Keep canonical terminal state in the daemon and expendable replica/view state in smart clients;
  never treat a replica as authority.
- Never move socket naming, locks, or daemonization into the core.
- Never expose Ghostty headers or private checkpoint layout outside the terminal adapter.
- Do not let client lag, checkpoint/history work, presentation, or extensions block PTY progress.
- Preserve bounds when generalizing a single object into an arena.
- Add state transitions through typed commands instead of direct cross-component mutation.
- Keep checkpoint feasibility, ID migration, protocol introduction, renderer relocation, and feature
  behavior in reviewable tested steps.
- Update this document when ownership or a runtime invariant changes.
