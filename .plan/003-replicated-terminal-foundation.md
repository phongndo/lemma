# Fiber replicated-terminal foundation

## Status

Proposed and contingent on a **Pass** result from
[`002-terminal-checkpoint-feasibility.md`](002-terminal-checkpoint-feasibility.md). Do not begin
production checkpoint/event protocol work while that gate is unresolved.

This plan replaces the former assumption that P1 would frame daemon-generated ANSI. It implements
the single target architecture in [`../docs/architecture.md`](../docs/architecture.md): smart clients
attach from terminal checkpoints, apply ordered pane events, own presentation, and recover through
fresh checkpoints. The current server-rendered `fiber-v8` path remains a protected migration
baseline until cutover, then is removed from attached output.

## Outcome

At completion:

- workspaces, panes, windows, and clients have authoritative generational IDs;
- one bounded versioned client protocol carries commands, topology, terminal checkpoints, pane event
  tails, input, acknowledgements, history, and resynchronization;
- the daemon gives every pane one total terminal-event order;
- a smart client owns replica terminals and consumes that protocol;
- the existing ANSI compositor runs behind the smart client rather than in the daemon;
- initial attach, disconnect/reconnect, lag recovery, and SSH stdio use checkpoint plus event tail;
- the daemon no longer sends unframed/composed ANSI to production attached clients; and
- local/SSH correctness, bounds, and performance evidence are checked in.

This is the replication foundation and installable-alpha protocol path. It is not the final native GPU
client or multiplayer release.

## Non-goals

- Native GPU/font/window-system implementation.
- Web or mobile clients.
- Multiple simultaneous attached clients or permission/control-transfer UX.
- Public stable RPC compatibility guarantees beyond the alpha protocol policy.
- Full copy/search/selection UX.
- Lua callback/events/process API completion.
- Daemon-crash or reboot persistence.
- Cell-delta replication or a permanent daemon ANSI output mode.
- QUIC/WebTransport or hosted relays.

## Locked design

### One synchronization algorithm

For every pane:

```text
checkpoint(seq=N) -> ready -> ordered event N+1...
```

Events include output, resize, reset, and exit. Resume from acknowledged sequences is allowed only
when the complete required tail remains available and versions match; otherwise the client receives
a fresh checkpoint. Scrollback uses bounded range chunks and does not block visible readiness.

### One production output protocol

The generalized daemon protocol never treats ANSI as terminal state. During migration, `fiber-v8`
and the new endpoint may coexist only for explicit tests/cutover. The final compatibility client
imports replicas and invokes the existing ANSI compositor locally. Native presentation later consumes
the same replicas.

### One authority

The daemon owns process, PTY, topology, dimensions, canonical terminals, sequence allocation,
terminal responses, application input encoding, and command validation. Clients own disposable
replicas, physical presentation, viewport/selection, input decoding, and local Fiber chrome hit
testing.

### Bounded lag

Per-client protocol queues, retained event tails, acknowledgement state, checkpoint work, and history
work have byte/element/time bounds. A lagging client is reset to a newer checkpoint or disconnected;
it never blocks PTYs and never creates an unbounded raw-output log.

## Workstream A — authoritative identities

- [ ] Move workspaces into a dense generational store and assign `WorkspaceId`.
- [ ] Move panes into a dense generational store and assign `PaneId`.
- [ ] Assign `ClientId` to pending, control, and attached clients with explicit lifecycle states.
- [ ] Preserve and integrate existing generational `WindowId` behavior.
- [ ] Resolve every command and protocol target at the core trust boundary.
- [ ] Reject stale, cross-workspace, unauthorized, and type-confused IDs.
- [ ] Add create/remove/reuse/wraparound/stale-ID property and component tests.

### A exit gate

- [ ] No replication message relies on workspace names or local pane slots as authoritative identity.
- [ ] Dense iteration and all configured capacity bounds remain explicit.
- [ ] Current server-rendered process behavior remains green before protocol changes begin.

## Workstream B — generalized envelope and semantic control

Define a bounded bidirectional envelope with at least:

- magic, major/minor protocol version, kind, flags, payload length, request ID, and stream/client
  correlation where required;
- typed success, no-effect, capacity, unavailable, invalid-target, unauthorized, mismatch, and
  malformed errors;
- capability negotiation for terminal checkpoint version/features, typed input, history, compression,
  presentation, and transport behavior;
- explicit daemon and client hello/mismatch diagnostics; and
- independent incremental decoders with fixed maximum frame, buffered bytes, messages per turn, and
  retained output.

- [ ] Add golden encodings and round-trip tests for every envelope and control value.
- [ ] Add fragmented/coalesced/malformed/oversized/unknown-version/unknown-capability tests.
- [ ] Add request cancellation/lifetime behavior needed by attach and control operations.
- [ ] Add a fuzz target and bounded seed corpus.
- [ ] Allocate a distinct development endpoint so old/new peers cannot silently cross protocols.

### B exit gate

- [ ] Both directions are framed and independently versioned.
- [ ] Protocol values borrow decoder storage only under an explicit synchronous lifetime.
- [ ] Invalid input cannot partially mutate authoritative or replica state.

## Workstream C — pane event sequencing and checkpoints

- [ ] Give every live pane a monotonically increasing sequence covering output, resize, reset, and
      exit.
- [ ] Represent PTY output as bounded immutable/ref-counted or equivalently nonduplicated chunks that
      canonical parsing and eligible client queues can consume safely.
- [ ] Preserve the existing ordering of PTY output, terminal responses, and later user input.
- [ ] Export a visible-ready checkpoint fenced at an explicit sequence.
- [ ] Queue events arriving during export after that fence without loss or duplication.
- [ ] Add bounded recent-to-oldest history range/chunk messages.
- [ ] Add server-side acknowledgement and resumable-tail bookkeeping with aggregate memory limits.
- [ ] Add fresh-checkpoint reset when the required tail is absent or a client exceeds its lag bound.

### C exit gate

- [ ] Checkpoint and tail equivalence tests from `.plan/002` run against the production sequencing
      path.
- [ ] A detached workspace needs no client event log beyond explicit bounded policy.
- [ ] One lagging/non-reading client cannot alter PTY or another workspace's progress.
- [ ] Terminal responses remain daemon-only and ordered before subsequent input.

## Workstream D — one-pane smart client

- [ ] Implement handshake, attach, checkpoint import, ready, event application, acknowledgement,
      reset, and disconnect states as an exhaustive bounded client state machine.
- [ ] Add a generational/fixed-capacity replica store using the Fiber terminal adapter's replica role.
- [ ] Keep candidate checkpoint import unpublished until validation and allocation succeed.
- [ ] Decode typed key/text/paste/focus/resize input without relying on daemon ANSI output.
- [ ] Render one replica through the existing ANSI backend inside a controlled outer terminal.
- [ ] Restore outer terminal state on normal, failure, signal, mismatch, and partial-startup paths.
- [ ] Add process tests for attach, ordinary input/output, detach, reattach, child exit, and protocol
      failure over the new endpoint.

### D exit gate

- [ ] The one-pane smart client presents the same semantic screen as the P0 client for the existing
      corpus.
- [ ] No daemon-rendered terminal bytes are needed by the new client.
- [ ] Client destruction cannot affect daemon pane/process lifetime.

## Workstream E — topology replication and client-side composition

- [ ] Send bounded topology snapshots and ordered deltas with stable workspace/window/pane IDs.
- [ ] Replicate active/previous window, focus, zoom, logical split tree, ratios, status labels, and
      canonical pane dimensions.
- [ ] Move physical rectangle resolution and the tested pane ANSI compositor behind `fiber_client`.
- [ ] Keep server logical layout validation authoritative while making client presentation expendable.
- [ ] Route Fiber chrome input as semantic commands with stable targets.
- [ ] Route application mouse values with `PaneId` and pane-local coordinates; defer complete mouse UX
      if needed but freeze the correct target shape.
- [ ] Rebuild client presentation after topology snapshot, reset, resize, active-window change, and
      output backpressure.

### E exit gate

- [ ] Existing split/focus/zoom/window process scenarios pass through client-side replicas and
      composition.
- [ ] Server and client topology digests agree after every tested delta.
- [ ] No presentation rectangle or outer coordinate becomes an authoritative core identity.

## Workstream F — lag, reconnect, and corruption recovery

- [ ] Define contiguous per-pane acknowledgement semantics and cadence.
- [ ] Exercise partial writes, small socket buffers, stopped readers, delayed acknowledgements, and
      aggregate tail exhaustion.
- [ ] Reset a lagging replica from a fresh checkpoint without pane/process loss.
- [ ] Resume after reconnect only when session identity, versions, topology, and retained event ranges
      permit it.
- [ ] Fall back to a full topology/checkpoint transaction for every unsafe resume case.
- [ ] Detect duplicate, missing, out-of-order, wrong-pane, stale-generation, and checksum/digest
      mismatch conditions.
- [ ] Disconnect clients that cannot make bounded checkpoint progress while unrelated work continues.

### F exit gate

- [ ] No client queue or retained event tail can grow without a configured aggregate bound.
- [ ] Recovery is observed, not inferred from eventual socket close.
- [ ] Repeated forced resynchronization leaves client/server state equivalent and no processes or
      descriptors orphaned.

## Workstream G — SSH-stdio transport proof

Use the same application frames and state machines through a transport adapter. SSH handles initial
authentication and encryption; Fiber continues validating every decoded value as untrusted.

- [ ] Add test-owned SSH-stdio or equivalent subprocess transport plumbing without embedding SSH
      policy in core/protocol code.
- [ ] Exercise attach, input, detach, reconnect, resume, fresh checkpoint, history hydration, and
      mismatch behavior.
- [ ] Add shaped latency, bandwidth, jitter, and short-write scenarios with bounded deterministic
      harness controls.
- [ ] Prioritize control/input/live visible events over low-priority history without violating per-pane
      event order.
- [ ] Measure optional bounded compression for large checkpoint/history/output chunks; do not compress
      small interactive frames without evidence.
- [ ] Document that full remote CLI/config/bootstrap UX remains a later product decision.

### G exit gate

- [ ] Unix and SSH paths pass the same golden, malformed, synchronization, and process behavior suite.
- [ ] Input remains responsive during progressive history and another pane's output flood.
- [ ] Transport loss never ends pane processes or corrupts canonical state.

## Workstream H — cutover, performance, and closeout

- [ ] Make the smart client protocol the production attach path.
- [ ] Remove daemon-to-attached-client unframed/composed ANSI and obsolete frame scheduling state.
- [ ] Keep reusable ANSI composition in the client presentation backend.
- [ ] Remove the old endpoint after explicit mismatch/migration behavior is documented and tested.
- [ ] Update current capabilities, architecture, component READMEs, TODO, roadmap, and user docs.
- [ ] Produce installable alpha artifacts only after the exit gate passes.

Required measurements, with current P0 results retained as labeled baselines:

- [ ] key-to-PTY and key-to-visible compatibility-client latency;
- [ ] PTY-read-to-client-event and event-to-visible latency;
- [ ] checkpoint export/import/attach-to-ready latency and bytes;
- [ ] raw event bytes for sparse editor, full redraw, synchronized-update, and warm-scroll workloads;
- [ ] lag detection to restored presentation time;
- [ ] recent/full scrollback hydration time and bytes;
- [ ] server/client CPU and memory for 1/4/16/maximum panes; and
- [ ] the same core distributions over local Unix and shaped SSH transports.

### H exit gate

- [ ] Production attachment uses one checkpoint/event architecture.
- [ ] Every existing local mux behavior remains process-tested after renderer relocation.
- [ ] No unexplained regression is hidden by comparing different workload completion semantics.
- [ ] Current-state docs no longer describe daemon ANSI as the production target.

## Required validation

- [ ] `just check`
- [ ] `just ci-check`
- [ ] Debug/release component and process suites.
- [ ] Protocol fuzz corpus and malformed matrix.
- [ ] Checkpoint equivalence corpus.
- [ ] Repeated and parallel local/SSH process runs without leftovers.
- [ ] Four supported host architectures.
- [ ] Linux ASan/UBSan with smart-client process tests.
- [ ] Local and shaped-SSH benchmark artifacts.
- [ ] `git diff --check`
- [ ] Documentation link check.

## Commit sequence

1. **Authoritative IDs** — dense workspace/pane/client stores and tests; no wire change.
2. **Generalized envelope** — hello, errors, IDs, requests/results, golden/fuzz tests.
3. **Pane event sequencing** — output/resize/reset/exit order and bounded chunk ownership.
4. **Production checkpoint attach** — fence, visible-ready checkpoint, event tail, history ranges.
5. **One-pane smart client** — replica lifecycle and local ANSI presentation.
6. **Acknowledgement and resynchronization** — bounded lag, reset, resume/fallback.
7. **Topology replication** — multi-pane client composition and semantic chrome targets.
8. **SSH transport proof** — shared suites, shaped links, compression evidence.
9. **Production cutover** — remove daemon ANSI attach path and old endpoint.
10. **Alpha closeout** — artifacts, docs, benchmarks, hosted validation.

Each commit must retain a runnable tested attach path. Temporary dual endpoints are migration
scaffolding and must not become a release architecture.

## Review checkpoints

Stop and review before proceeding if:

- `.plan/002` has not archived a Pass decision;
- output message design degenerates into framed daemon ANSI;
- a second cell-delta replication architecture is introduced;
- sequence ownership or checkpoint fencing is ambiguous;
- a client can generate PTY responses or encode authoritative application input from replica modes;
- lag recovery requires unbounded raw-byte retention;
- client-side presentation values become core identities;
- SSH requires different application semantics from local attachment;
- renderer relocation is mixed with unrelated feature breadth such that P0 behavior cannot be
  compared; or
- native GPU work is used to postpone proving the protocol with the compatibility backend.

## Completion gate

This phase is complete only when:

1. stable generational IDs identify every replicated object;
2. checkpoint plus ordered tail is the only production attached terminal-data model;
3. smart clients own replica terminals and presentation;
4. lag and reconnect recover through bounded resume or fresh checkpoint paths;
5. the same protocol and tests pass over Unix sockets and SSH stdio;
6. the daemon has no production unframed/composed ANSI attached-output path;
7. P0 process behavior remains green through client-side composition; and
8. local/remote performance, bytes, memory, and recovery evidence is checked in and honestly labeled.
