# Lemma architecture

## Model

```text
physical keyboard       CLI / mouse / Lua / agent
       |                         |
 daemon input policy       typed semantics
       |                         |
       +------ typed command ----+
                    |
                    v
                  CORE
                |
        semantic intent
                |
                v
            RUNTIME
          /    |     \
   terminal  render  platform/protocol
       |
       v
 libghostty-vt
```

```text
CORE    = meaning / semantic state / policy
RUNTIME = execution / external resources / reactor mechanics
```

Core answers what a command means and which semantic transition is valid. Runtime makes accepted intent happen using processes, PTYs, terminals, transports, clocks, and presentation resources. Runtime reports typed outcomes and observations back; it does not invent mux policy.

The current tree does not yet need to match this split. Moving files alone does not improve the design.

## Authoritative model

One per-user daemon is authoritative. It owns the Core and Runtime stores and is the only process allowed to commit mux state or parse pane PTY output. Clients are replaceable views and input sources; their failure must not end pane processes.

The fundamental mux hierarchy is:

```text
Session -> Tab -> Pane
```

- **Session** is the durable-within-the-daemon naming, attachment, launch-policy, and process-lifecycle boundary.
- **Tab** belongs to one session and owns pane layout, focus, zoom, and ordering semantics.
- **Pane** belongs to one tab and identifies one process surface semantically.

Workspaces, projects, worktrees, tasks, and agent runs compose stable IDs outside the kernel. They become kernel concepts only if correctness requires kernel ownership of state that cannot be represented by IDs, commands, snapshots, events, and extension policy.

## Semantic and runtime counterparts

Semantic identity is not resource lifetime:

```text
Session != Attachment != AttachmentRuntime
Pane    != PaneRuntime
```

- **Session** owns semantic mux state and attachment policy.
- **Attachment** is a Core relationship between an actor/view and a session. It owns semantic view policy such as control, focus/view state, copy-mode policy, and stable identity.
- **AttachmentRuntime** is the replaceable connection: descriptor, decoder, output progress, deadlines, transport queues, and outer-client lifecycle.
- **Pane** owns semantic identity, membership, layout participation, and launch intent.
- **PaneRuntime** owns the child process, PID, PTY, concrete `vt::Terminal`, ordered PTY writes, and runtime scheduling state.

Disconnecting an `AttachmentRuntime` does not destroy its session. Losing a `PaneRuntime` produces a typed runtime outcome from which Core applies the pane-exit policy.

## Ownership

Every mutable value has exactly one owner. References are borrowed and bounded in lifetime; stable IDs cross stages and trust boundaries.

| State | Authoritative owner |
| --- | --- |
| Sessions, tabs, panes, layout, focus, zoom, stable IDs | Core store |
| Attachments, controller/view/copy policy | Core store |
| Compiled keymap generation and per-Attachment input contexts | Input policy |
| PTYs, processes, PIDs, descriptors, polling, clocks | Runtime |
| Concrete terminal lifetime and adapter queues | PaneRuntime / terminal component |
| Canonical VT screen, history, modes, cursor, tracked terminal references | Ghostty behind `vt::Terminal` |
| Protocol decoder and connection output progress | AttachmentRuntime |
| Non-authoritative frame storage and physical presentation shadow | Runtime rendering owner |
| Endpoint, lock, listener, daemonization | Daemon/platform runtime |
| Validated extension registrations and semantic effects | Core |
| Lua VM, extension process, extension transport | Extension runtime |

A value may be projected into another component, but the projection must be immutable or explicitly non-authoritative. Two components must never believe they can independently mutate the same fact.

## Commands and state transitions

All semantic mutations converge on typed commands, regardless of origin:

```text
keyboard -> daemon input policy -+
mouse / CLI / Lua / agent --------+-> typed command
                                      -> validate actor, target ID, bounds, and policy
                                      -> one Core transition
                                      -> typed result + semantic intent
```

Physical input that is not a mux command becomes typed application input. The daemon input-policy component owns compiled keymaps and bounded transient input contexts; named contexts and physical bindings are not mux state. A compiled binding may translate a physical chord to another application key and must preserve the originating action through release; host-modifier meaning lives in the generation, not in the encoder. Runtime resolves application input to the target PaneRuntime and asks Ghostty to encode mode-dependent input. No frontend receives a private mutation path.

Malformed input, stale IDs, capacity exhaustion, unavailable runtime resources, and no-effect commands are explicit results. External failure never authorizes partial semantic mutation. Internal invariant failure is fail-fast.

## Dependency direction

Dependencies are explicit and acyclic:

```text
frontends ---------> typed physical input
input policy ------> semantic values/commands ---------> Core
Runtime -----------> Core contracts
Runtime -----------> terminal / render / protocol / platform
terminal ----------> libghostty-vt
```

Core must be testable without PTYs, Ghostty, sockets, child processes, or a running reactor. It does not know CLI grammar, socket naming, Lua stack details, native handles, or Ghostty types.

Runtime may orchestrate mechanisms but may not bypass Core to mutate semantic state. Protocol owns bounded schemas and codecs, not sockets or dispatch. Platform owns OS mechanisms, not policy. Render owns presentation projection, not terminal or mux authority. Components should remain cohesive; one target per class is not a goal.

The current CMake target graph is transitional. Existing links do not define the target dependency direction.

## Invariants

1. One daemon is the sole authority for mux state and pane terminal truth.
2. `Session -> Tab -> Pane` is the kernel hierarchy.
3. `Session`, `Attachment`, and `AttachmentRuntime` are distinct concepts and lifetimes.
4. Every mutable value has exactly one clear owner.
5. Semantic state and policy are separated from OS/resource state and reactor mechanics.
6. Every semantic mutation converges on a typed command and typed result.
7. Dependencies remain explicit and acyclic; mechanisms do not mutate policy-owned state directly.
8. Slow, malformed, blocked, or crashed clients and extensions cannot prevent PTY progress.
9. Every queue, buffer, payload, batch, loop, timeout, allocation, and resource has a defensible bound.
10. External dependency representations never leak through Lemma-owned boundaries.
11. Architecture must not add abstraction, copying, allocation, dispatch, or pointer chasing to hot paths without evidence that the tradeoff is worthwhile.
12. Workflow concepts such as projects, workspaces, and agent runs remain outside the kernel unless correctness truly requires kernel ownership.
13. Required input and terminal-response ordering is explicit and preserved.
14. Visible state can be reconstructed from daemon authority without an unbounded event, PTY-byte, or render log.
15. Capacity exhaustion and dependency failure degrade or reject boundedly; they never corrupt authority.
16. Published input-policy generations contain only resolved, unambiguous bindings; context stacks are bounded, Attachment-scoped, and cannot outlive their generation.

## Runtime progress

A reactor iteration has bounded work in each class: PTY reads, terminal parsing, PTY writes, client input routing steps and routed commands, semantic commands, presentation, connection output, and extension work. Fair cursors prevent low-index resources from monopolizing repeated turns.

Terminal responses generated while parsing PTY output enter the pane's ordered PTY queue before later accepted application input. Slow presentation retains at most bounded work; newer terminal damage stays canonical and is repaired by a full redraw or client disconnect.

The exact scheduling algorithm is implementation policy, not an architectural phase sequence. The invariant is independent progress with preserved ordering and bounds.

## Presentation

The daemon uses server-rendered ANSI, but presentation remains downstream of canonical terminal and mux state. Each AttachmentRuntime uses one bounded framed socket transport for control and rendered output; the replaceable client alone owns and writes the outer-terminal descriptor. A presentation snapshot, delta, retained physical shadow, or frame buffer is replaceable and non-authoritative.

Do not add a second normal presentation transport or transfer the outer-terminal descriptor without new evidence that the latency benefit justifies the additional protocol, descriptor-lifetime, polling, fallback, and failure-recovery paths.

A native renderer may be added only as another bounded projection. It must not require client PTY replay, a second parser authority, or private Ghostty representation outside the terminal component.

See [`terminal.md`](terminal.md) for the terminal boundary and [`quality.md`](quality.md) for proof and performance policy.

## Review questions

For any structural change, ask:

1. Who owns every changed mutable value?
2. Is it semantic state, runtime state, canonical terminal state, or presentation state?
3. Which direction does each dependency point?
4. Which typed command or outcome crosses the Core/Runtime boundary?
5. What bounds work, storage, waiting, and failure?
6. Can one slow resource delay unrelated PTYs?
7. Did responsibility become less duplicated and the design easier to explain?
8. Did the change add cost to a multiplicative path, and what evidence justifies it?
