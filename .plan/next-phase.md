# Fiber next phase: protect and harden the local mux foundation

## Status

Proposed immediate implementation phase. This plan begins after the current capability audit,
roadmap, daily-driver contract, and TODO documentation are committed as one baseline documentation
change.

Detailed process-harness design:
[`../docs/plans/process-level-pty-harness.md`](../docs/plans/process-level-pty-harness.md).

## Outcome

At the end of this phase, Fiber should provide the same local mux behavior it provides today, but
with three foundational guarantees:

1. The real daemon/client/workspace lifecycle is protected by isolated process-level PTY tests.
2. No accepted connection can block PTY progress, rendering, or other clients.
3. A temporarily blocked PTY cannot detach a client, retire a pane, or silently lose accepted input.

This is a hardening phase, not a feature phase.

## Why this is the next phase

Fiber already creates persistent workspaces, windows, split panes, login-shell PTYs, Ghostty terminal
state, damage-rendered frames, keyboard commands, detach/reattach state, and isolated Lua
registration. The capability audit found that the highest risks are below that feature surface:

- setup/control connections perform blocking reads and writes inside the authoritative reactor;
- user input and terminal responses write directly to nonblocking PTYs without queues; and
- no checked-in process test protects the complete daemon/client path before refactoring it.

Adding generational stores, a new protocol, mouse input, copy mode, or remote operation before fixing
those gaps would broaden an unprotected foundation.

## Scope

### Included

- Immutable runtime endpoint injection through internal app/client/daemon boundaries.
- Test-owned foreground daemon entry point using the production listener/core serve path.
- C++/GoogleTest process and pseudoterminal support.
- End-to-end tests for current local mux behavior.
- Bounded nonblocking pending-connection state.
- Nonblocking attach and control responses, including the initial frame.
- Bounded ordered PTY write queues.
- Partial-write, `EINTR`, `EAGAIN`, overflow, timeout, and fairness tests.
- CI/sanitizer integration and capability/TODO updates.

### Explicitly excluded

- Generalized/versioned protocol wire redesign.
- Authoritative workspace/pane/client store migration.
- Typed extended keyboard, paste, focus, or mouse protocol values.
- Mouse hit testing or application mouse encoding.
- Interactive pane ratios, names, copy mode, selection, or clipboard.
- Lua callbacks/events/UI.
- Remote, multi-client, or agent APIs.
- Daemon-crash process survival.

Those begin only after this phase exits cleanly.

## System design locked for this phase

### Preserve the single-writer reactor

The core remains a bounded single-threaded owner of mux, PTY, terminal, layout, and attached-client
state. Do not add worker threads, per-pane actors, pane brokers, or blocking helper calls.

### Inject endpoints; do not add mutable test globals

Introduce an immutable internal runtime endpoint value and pass it through application dispatch,
daemon control operations, and client attach. The production `fiber` entry point constructs the
existing `/tmp/fiber-v8-<uid>.sock` endpoint, so user behavior does not change.

Tests use unique absolute paths under fixture-owned `0700` temporary directories. No test may touch,
list, attach to, or kill the user's default daemon.

### Own the test daemon

A test-only executable invokes the same internal daemon serve path in the foreground with an injected
endpoint and extension loading disabled. The fixture owns its process group and always terminates and
reaps it. Production double-fork daemonization remains unchanged and outside this phase's mux
integration scenarios.

### Keep accepted connections as bounded reactor data

Add a fixed-capacity pending-connection store. A slot owns:

- generation/state;
- descriptor;
- incremental setup decoder state;
- bounded setup input;
- bounded control-response output;
- output offset; and
- progress deadline.

Current-protocol setup states are explicit and exhaustive:

```text
accepted
  -> read command
  -> read workspace length/name when required
  -> read attach dimensions when required
  -> prepare response or attach handoff
  -> flush response
  -> attached handoff or close
```

All accepted descriptors become nonblocking before entering a slot. Accept, read, decode, write, and
timeout work have per-turn budgets. An attached connection hands descriptor ownership to workspace
client state only after its setup has completed.

Do not redesign the wire format in this phase; preserve current bytes while changing execution from
blocking calls to incremental state.

### Reuse bounded rendering state

Do not allocate a maximum frame buffer per pending connection. Queue an initial attach frame through
the existing workspace frame/output state, then flush it nonblockingly. Small control responses use
bounded connection output and incremental generation where needed.

### Give every live pane an ordered PTY write queue

User input and terminal-generated responses append to one explicitly ordered pane queue. The reactor
polls `POLLOUT` only while the queue is nonempty and consumes only bytes successfully written.

Extend `BoundedByteQueue` with zero-copy contiguous readable spans and checked `consume` support so
partial writes do not require removing and reinserting data.

Queue policy for this phase:

- accepted input is either queued completely or remains in the client decoder until capacity exists;
- the reactor stops reading that client while its target pane cannot accept more input;
- terminal responses preserve order ahead of subsequently processed client input because PTY reads
  and response enqueueing precede client reads;
- no overflow is silent;
- a true terminal-response capacity failure is observable and follows one documented pane failure
  transition; and
- queue memory is allocated only for live panes and charged to an explicit per-pane limit.

The implementation must document the selected byte capacity and show that it can contain the
terminal adapter's maximum pending response plus at least one maximum client input frame, or use
separate reserved capacity while preserving ordering.

## Workstream A: process-level safety net

### A1. Runtime injection and drivers

- [ ] Add an immutable internal endpoint/runtime value.
- [ ] Thread it through app, daemon control, and client attach APIs.
- [ ] Keep production default endpoint and CLI behavior unchanged.
- [ ] Extract internal foreground `daemon::serve` from the double-fork launcher.
- [ ] Add test-only foreground server and injected CLI driver targets.
- [ ] Give mux tests an empty HOME/XDG/ZDOTDIR configuration environment.

### A2. Reusable test support

- [ ] Add `TemporaryRuntime` with private unique paths and bounded cleanup.
- [ ] Add `ChildProcess` with explicit environment, process groups, deadline waits, captured output,
      `SIGTERM`/`SIGKILL` escalation, and guaranteed `waitpid`.
- [ ] Add `PtyClient` with controlled size, nonblocking reads/writes, resize, output tail, and termios
      inspection.
- [ ] Feed PTY output into a test outer `vt::Terminal`; assert bounded plain screen state rather than
      raw ANSI layout.
- [ ] Add `ControlClient` for deadline-bound list/windows/kill operations and predicate polling.

### A3. Initial scenarios

- [ ] Create, attach, send a portable shell marker, render it, and detach.
- [ ] Split panes, exercise focus/zoom, create/select windows, detach, and reattach with retained
      topology.
- [ ] Kill the attached client abruptly, verify the workspace remains, and reattach interactively.
- [ ] Resize valid -> too small -> valid and verify suspension/reconstruction without disconnect.
- [ ] Exit the last shell and verify pane/window/workspace reclamation.
- [ ] Compare outer termios before/after normal detach and verify emitted terminal restoration.
- [ ] Run two fixtures concurrently and prove endpoint/process isolation.

### A exit gate

- [ ] Tests pass repeatedly on local macOS debug builds.
- [ ] Tests pass on Linux/macOS platform CI and Linux ASan/UBSan.
- [ ] Every operation and teardown has a hard deadline.
- [ ] No test leaves a daemon, shell, socket, lock, or temporary directory behind.
- [ ] Tests pass while a user's normal Fiber daemon/workspace is running.

## Workstream B: nonblocking accepted connections

### B1. Regression tests first

- [ ] Add a test that opens a connection and sends no command while attached shell output continues.
- [ ] Add a test that sends each setup field one byte at a time while PTYs continue.
- [ ] Add a test that requests attach but never reads the initial frame while another workspace
      remains responsive.
- [ ] Add slow/non-reading list and window-list control-client tests.
- [ ] Add malformed, disconnect-mid-field, setup-timeout, and connection-capacity tests.

These tests should expose current blocking behavior before the production state-machine change.

### B2. Pending-connection store

- [ ] Add a fixed-capacity slot array with generation and explicit state.
- [ ] Set listener and accepted descriptors nonblocking.
- [ ] Bound accepts per reactor turn.
- [ ] Incrementally consume current command/name/dimension fields.
- [ ] Validate names/enums/lengths before state mutation.
- [ ] Track monotonic progress deadlines.
- [ ] Reject capacity without affecting attached clients or PTYs.

### B3. Nonblocking responses and attach handoff

- [ ] Queue ready/busy/missing/capacity/failed responses.
- [ ] Queue workspace/window/config-error listings without blocking.
- [ ] Queue the initial full attach frame using workspace client output state.
- [ ] Close control connections only after queued output flushes or a bounded error/timeout.
- [ ] Transfer descriptor ownership exactly once on successful attach.
- [ ] Remove every blocking accepted-socket `read_exact`/`send_all` path from the reactor.

### B exit gate

- [ ] An idle accepted peer cannot change measured PTY/output progress in another workspace beyond
      normal test noise.
- [ ] No accepted-socket operation can block the reactor.
- [ ] Setup input/output and per-turn work are statically bounded.
- [ ] Fragmented/coalesced behavior remains wire-compatible with the current client.
- [ ] Existing component and process-level scenarios remain green.

## Workstream C: bounded PTY write backpressure

### C1. Queue primitive

- [ ] Add contiguous readable-span access to `BoundedByteQueue`.
- [ ] Add checked partial `consume`.
- [ ] Preserve existing wraparound/all-or-nothing append behavior.
- [ ] Add empty, wrap, partial-consume, full, and reuse tests.

### C2. Pane integration

- [ ] Add the selected bounded ordered queue to each live pane.
- [ ] Queue normalized user input.
- [ ] Queue terminal-generated responses.
- [ ] Poll pane `POLLOUT` only while data is pending.
- [ ] Flush with per-pane and global per-turn byte budgets.
- [ ] Handle partial write, `EINTR`, `EAGAIN`, HUP, and hard errors explicitly.
- [ ] Apply client read backpressure instead of consuming input that cannot be queued.
- [ ] Make capacity and hard-error behavior observable.

### C3. Stress and performance

- [ ] Fill a PTY write side, send input, release it, and verify exact ordered delivery.
- [ ] Verify one blocked pane does not delay input/output in another pane/workspace.
- [ ] Verify terminal responses precede subsequently accepted user input.
- [ ] Exercise queue wraparound, maximum input frames, repeated `EAGAIN`, and child exit with queued
      bytes.
- [ ] Benchmark key-to-PTY latency with idle, output-busy, and separately blocked panes.

### C exit gate

- [ ] `EAGAIN` never detaches a client or retires a live pane.
- [ ] Accepted bytes are delivered in order or rejected/backpressured before acceptance.
- [ ] No queue overflow is silent.
- [ ] PTY write work is bounded per pane and globally per reactor turn.
- [ ] Process tests, sanitizer tests, and existing performance baselines remain green.

## Reactor order after this phase

The authoritative turn remains single-threaded and deterministic:

1. collect readiness/deadlines;
2. drain bounded PTY output;
3. enqueue terminal responses;
4. read/decode bounded attached-client and setup input;
5. apply bounded typed commands;
6. flush bounded PTY writes;
7. compose due frames;
8. flush bounded attached/control/setup output;
9. process deferred extension IPC; and
10. accept a bounded batch of new connections.

Exact ordering changes require tests demonstrating input, response, and rendering semantics.

## Commit sequence

Keep structural refactors separate from behavior hardening:

1. **Commit the planning baseline**
   - license/identity follow-up, capability audit, roadmap, daily-driver contract, TODO, and plans.
2. **Inject runtime endpoint and foreground serve**
   - behavior-preserving internal API refactor.
3. **Add process/PTY test support**
   - helpers and test-only drivers with self-contained cleanup.
4. **Protect current mux behavior end to end**
   - initial six scenarios and CI integration.
5. **Add pending nonblocking connection state**
   - regression tests first, then incremental setup reads/timeouts.
6. **Make control and initial-attach output nonblocking**
   - queued responses and ownership handoff.
7. **Extend bounded byte queue for partial writes**
   - isolated primitive change and tests.
8. **Queue and flush pane PTY writes**
   - input/responses, backpressure, fairness, stress tests.
9. **Close the phase**
   - run full checks/benchmarks, update audit/TODO, record remaining product decisions.

Each commit must build and pass the tests applicable at that point. Do not combine protocol redesign,
ID-store migration, mouse features, or copy mode into these commits.

## Validation required for phase completion

- [ ] `just check` passes.
- [ ] `just ci-check` passes.
- [ ] Debug and release process-level scenarios pass repeatedly.
- [ ] Four-platform scheduled suite passes.
- [ ] Linux ASan/UBSan process suite passes without orphan/leak suppression.
- [ ] Existing renderer and mux performance baselines show no unexplained regression.
- [ ] New blocked-peer and blocked-PTY latency tests pass.
- [ ] `git diff --check` and documentation link checks pass.
- [ ] `docs/current-capabilities.md`, `TODO.md`, and `docs/roadmap.md` reflect completed work.

## Review checkpoints

Stop and review design before proceeding if any of these occur:

- endpoint injection begins leaking socket policy into core;
- foreground testing requires changing production mux semantics;
- pending-connection output requires eager multi-megabyte allocation per slot;
- PTY queue capacity multiplies into an unacceptable daemon-wide bound;
- queue ordering between terminal responses and user input cannot be stated precisely;
- process tests require unbounded sleeps or depend on a particular user shell prompt; or
- a new thread/process is proposed to avoid making reactor state explicit.

## Phase completion statement

This phase is complete only when the following claim is true and continuously tested:

> Fiber's current local mux behavior is protected end to end; all daemon connections and PTY writes
> are bounded and nonblocking; no idle peer, slow reader, or temporarily blocked PTY can stop unrelated
> session progress.

The clean next phase after this one is authoritative workspace/pane/client IDs plus the generalized
versioned local protocol, followed by typed keyboard/mouse input.
