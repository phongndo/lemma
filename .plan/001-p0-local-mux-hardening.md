# Lemma P0 completion archive

## Archive status

This document preserves the P0 closeout plan, implementation decisions, evidence, and remaining
hosted validation. It is an archive, not the active plan. Subsequent architecture review selected a
checkpointed terminal-replication protocol before authoritative IDs and generalized wire production
work. The active feasibility gate is
[`002-terminal-checkpoint-feasibility.md`](002-terminal-checkpoint-feasibility.md), followed on Pass
by [`003-replicated-terminal-foundation.md`](003-replicated-terminal-foundation.md), as ordered in
[`../docs/roadmap.md`](../docs/roadmap.md).

Implemented locally on July 30, 2026. All 19 remaining P0 TODO items are complete. Debug and release
suites pass with 72 component and 12 process tests; local format/lint/LSP/CI checks, parallel process
tests, platform-driver execution, benchmark smoke, and the five-sample process benchmark pass. The
four-host scheduled workflow and Linux ASan/UBSan process run remain merge-time validation because
they cannot be executed from the current macOS host.

Implementation began from baseline `37ab15c`:

- the repository is clean on `main`;
- 64 component tests and four process-level tests pass;
- accepted connections and attached/control output are bounded and nonblocking;
- every live pane has one bounded ordered PTY write queue;
- the first three P0 workstreams had 29 checked and eight open items in [`../TODO.md`](../TODO.md);
- all 11 first-release product-decision items were open; and
- `scripts/ci/platform` and `scripts/ci/sanitizers` built only `lemma` and `lemma_tests`, so the
  process suite was absent from those scheduled lanes.

The earlier detailed harness design remains in
[`../docs/plans/process-level-pty-harness.md`](../docs/plans/process-level-pty-harness.md).

## Archived result

- The suite grew from 64 component/four process tests to 72 component/12 process tests.
- Existing focus, close, zoom, and window commands now have semantic process coverage.
- Raw setup peers cover fragmentation, coalescing, malformed fields, disconnects, timeout, capacity,
  slow control output, and slow initial attach.
- PTY and pending control-output flushing have deterministic writer seams for partial writes,
  `EINTR`, `EAGAIN`, budgets, and hard errors; a real gated PTY verifies exact 2 MiB recovery,
  fairness, and response/input order.
- `benchmarks/mux_benchmark.py` records warm-scroll and blocked-other-workspace visible-frame latency
  as bounded JSON. Cross-multiplexer numbers were removed until exact checked-in adapters exist.
- The v0.1 product decisions are recorded in `docs/product-contract.md`.
- Platform and sanitizer scripts now build and discover the process suite. The four hosted platforms
  and Linux sanitizers remain merge-time validation.

The sections below retain the original execution intent and checked completion evidence so future
work can distinguish what P0 proved from what later phases still need to implement.

## Outcome

P0 is complete when Lemma's existing local mux surface is protected end to end and this statement is
continuously true:

> Every accepted connection and PTY write is bounded and nonblocking; malformed, idle, slow, or
> blocked peers cannot stop unrelated session progress; accepted pane input is delivered exactly in
> order or backpressured before acceptance; and the first alpha's product boundaries are explicit.

Completing P0 closes exactly the remaining P0 items. It does not begin authoritative ID migration,
the versioned protocol, typed mouse input, copy mode, or new user-facing features.

## Original remaining scope (completed)

### Process harness: four items open at baseline

- Directional, next, and previous focus.
- Pane close and zoom.
- Window create, cycle, direct select, and close.
- Checked-in warm-session multiplexer benchmark harness.

### Accepted connections: two items open at baseline

- Fragmented, coalesced, idle, disconnecting, malformed, and non-reading peers.
- Slow control clients and slow initial-attach clients.

### PTY write backpressure: two items open at baseline

- Blocked PTYs, partial writes, recovery, overflow/backpressure, and fairness across panes.
- Input latency while another pane's PTY write side is blocked.

### First-release decision gate: 11 items open at baseline

The decisions in the P0 section of [`../TODO.md`](../TODO.md) must be selected and recorded in
[`../docs/product-contract.md`](../docs/product-contract.md). A decision may deliberately defer a
feature, but it may not leave v0.1 behavior ambiguous.

## Non-goals

- No generalized or versioned wire envelope.
- No workspace, pane, or client store migration.
- No new keyboard protocol, paste boundary, focus, or mouse value.
- No pane ratios, names, copy/search/selection, or clipboard.
- No Lua callbacks, events, snapshots, or rendered extension UI.
- No remote transport, multiple attached clients, or agent API.
- No daemon-crash or reboot persistence implementation.
- No performance claim based only on a microbenchmark or one successful run.

## Execution order

1. Make the process support deterministic enough to identify focused panes and drive raw peers.
2. Complete pane/window behavior scenarios.
3. Complete accepted-connection adversarial scenarios.
4. Add deterministic PTY-write unit seams and process stress.
5. Check in the warm-session and blocked-PTY latency harnesses.
6. Resolve and document the first-release product contract.
7. Put process tests in every claimed CI/sanitizer lane and close the documentation.

Tests should precede production changes. If an adversarial test exposes a defect, fix that defect in a
separate commit before continuing to the next workstream.

# Workstream A — finish reusable process support

The existing `TemporaryRuntime`, `ChildProcess`, and `PtyClient` remain the base. Extend them narrowly;
do not put test switches or mutable globals into production code.

## A1. Raw current-protocol peer

Move the ad hoc raw socket functions from `tests/e2e_mux_test.cpp` into an RAII test helper, for
example `RawPeer` under `tests/support/`.

Required operations:

- connect to an injected `RuntimeEndpoint` under an absolute deadline;
- set nonblocking mode and a small receive buffer;
- send one span, one byte at a time, or a sequence of fragments under a deadline;
- send a current-protocol attach or control request without using the production CLI;
- read a byte, read until EOF, drain slowly in caller-selected chunks, and wait for peer close;
- retain bounded sent/received tails plus the last `errno` for assertion diagnostics; and
- close exactly once in its destructor.

This helper speaks only the current P0 protocol. Do not turn it into a public protocol abstraction;
the P1 protocol replacement is allowed to replace it.

## A2. Listing and screen observations

Add test-only parsers for the stable diagnostic fields already emitted by control listings:

- workspace window count, pane count, attached state, dimensions, and focused child PID;
- active/inactive window number and pane count; and
- bounded cursor/screen observations from the outer `vt::Terminal` where listing state is
  insufficient.

Use the focused child PID to identify panes. Each created pane has a distinct shell child PID, so the
focus scenarios do not need public pane IDs before P1.

## A3. Deterministic PTY workload helper

Add a test/benchmark-only executable, tentatively `lemma_test_pty_peer`, that can be launched from the
account shell with a safely quoted absolute path. It must support bounded modes for:

- announcing readiness, entering an appropriate no-echo input mode, and waiting on a fixture-owned
  gate path before reading;
- reading an exact byte count and reporting a digest/sequence result;
- emitting a terminal query before reading so response-before-input ordering can be checked;
- echoing fixed tokens for key-to-PTY and key-to-visible-frame latency samples; and
- producing the 25,000 by 79-column warm-scroll workload followed by a unique completion marker.

Every mode has its own hard timeout and compact failure output. The helper must not depend on the
user's shell prompt, dotfiles, Python installation, or platform-specific command-line utilities.
`TemporaryRuntime` must own and remove all gate and side-channel paths.

## A exit gate

- [x] No raw descriptor ownership remains open-coded in a test body.
- [x] Every helper operation takes an absolute deadline.
- [x] Failed waits print endpoint, peer state, server tail, client raw tail, and parsed screen/listing.
- [x] Two fixtures still run concurrently without shared paths or global state.
- [x] Existing four process tests remain green before new scenarios are added.

# Workstream B — complete pane and window scenarios

Split the current broad topology test where needed so a failure identifies one behavior rather than
an entire lifecycle.

## B1. Directional, next, and previous focus

Add `MuxProcessTest.RoutesDirectionalNextAndPreviousFocus`:

1. Start one pane and record focused PID A.
2. Split left/right and record new focused PID B.
3. Split B top/bottom and record new focused PID C.
4. Assert the resulting geometry through the rendered separators.
5. From C, exercise up -> B, left -> A, right -> B, and down -> C.
6. Exercise next from C -> A and previous -> C.
7. After every transition, poll the workspace listing and assert the expected focused PID.
8. Send a unique marker after selected transitions to prove input reaches the focused live pane, not
   merely that listing metadata changed.

Avoid fixed sleeps and avoid process-title assertions.

## B2. Close and zoom

Add `MuxProcessTest.ClosesPanesAndTogglesZoom`:

- seed two panes with distinct visible markers;
- zoom the focused pane and require a full reconstruction showing only the focused surface plus Lemma
  chrome;
- unzoom and require both pane surfaces and their separator to return;
- close the focused pane and assert the pane count, focus PID, geometry compaction, and continued input
  in the survivor;
- close the final pane and assert that the final window and workspace are removed, the attached
  client disconnects, and its terminal state is restored.

## B3. Complete window command coverage

Add `MuxProcessTest.CreatesCyclesSelectsAndClosesWindows`:

- create at least three windows and parse `lemma windows` output;
- verify active/previous state through next and previous cycling;
- directly select existing windows with `C-b 1` through `C-b 3`;
- directly select a missing window and verify topology remains unchanged;
- close an active non-final window and verify active selection plus surviving window order;
- prove inactive windows retained their shells by returning and sending a marker; and
- close back to one window without ending the workspace.

The existing child-exit test continues to cover child-driven final-workspace reclamation.

## B exit gate

- [x] The three process-level TODO items are each represented by named deterministic tests.
- [x] Assertions check semantic state, not only that a command byte was accepted.
- [x] Tests pass repeatedly in debug and release builds on macOS; Linux is scheduled validation.
- [x] No scenario relies on a particular shell prompt or foreground-process name.

# Workstream C — adversarial accepted connections

Retain the production five-second setup-progress deadline and current wire bytes. P0 tests execution
semantics; P1 will redesign representation and diagnostics.

## C1. Fragmentation and coalescing matrix

Add table-driven raw-peer coverage for every setup field:

| Case | Delivery | Required result |
| --- | --- | --- |
| create/list/list-windows/kill | header/name in one write | Same result as CLI |
| attach | command, name length, name, dimensions in one write | Ready and initial frame |
| named commands | one byte per write | Same result without delaying another workspace |
| attach | dimensions fragmented independently | Ready only after all four bytes |
| multiple fields | uneven 1/2/3-byte fragments | Ordering and field boundaries preserved |

While each fragmented request is incomplete, keep an attached workspace producing and rendering
unique markers.

## C2. Disconnect, malformed input, timeout, and capacity

Cover these state-machine exits explicitly:

- disconnect before command;
- disconnect after command, name length, partial name, and partial dimensions;
- unknown command;
- zero and oversized name lengths;
- invalid workspace characters;
- zero and out-of-range attach dimensions;
- idle peer expiration after the real setup deadline;
- pending-slot capacity response; and
- slot reuse after malformed, disconnected, and timed-out peers.

Each case must prove the server remains alive and a normal control or attached request still succeeds.
Use one real timeout process test rather than injecting a shorter production timeout.

## C3. Slow control reader

Create one responsive workspace plus enough detached, maximum-length-named workspaces to make `list`
output exceed a deliberately small receiving socket buffer. Then:

1. send the list request and stop reading;
2. prove PTY/input/render progress in the responsive workspace;
3. drain the control response in small chunks under a deadline;
4. verify every listing is complete and ordered; and
5. verify the server closes the control connection only after queued output is flushed.

If platform socket buffering prevents a deterministic process-level partial send, retain this
isolation scenario and add a scripted unit test around the pending-output flusher. Do not add sleeps
or oversized unbounded output merely to influence the kernel.

## C4. Slow initial attach reader

Attach a raw peer at the maximum supported viewport with a deliberately small receive buffer and do
not read the initial composed frame. Prove another workspace remains interactive, then resume reads,
reconstruct the frame in a test terminal, and prove the slow client itself becomes interactive.

Distinguish this from a slow setup response: the one-byte `ready` response must flush before descriptor
ownership transfers to workspace client output.

## C exit gate

- [x] All peer classes named by the two open TODOs have explicit coverage.
- [x] Malformed peers are disconnected without state mutation or server loss.
- [x] Slow readers recover with complete output; they are not merely abandoned at teardown.
- [x] Connection slot reuse and attach-reservation release are asserted.
- [x] Unrelated PTY progress remains observable during every blocked/slow case.

# Workstream D — deterministic PTY write backpressure

Use both component tests and real process tests. Kernel behavior alone cannot deterministically prove
partial writes or `EINTR`, while a mocked writer alone cannot prove real PTY isolation.

## D1. Extract a narrow write-flush seam

Move the queue-consumption loop currently private to `engine.cpp` behind a core-internal,
allocation-free helper with a scripted writer seam. Preserve production policy exactly:

- 64 KiB per-pane budget;
- 1 MiB global per-turn budget;
- at most 32 write attempts per pane per call;
- consume only bytes reported written;
- retry `EINTR` within the attempt bound;
- retain all unwritten bytes on `EAGAIN`/`EWOULDBLOCK`; and
- report a hard descriptor error so the engine retires the pane.

The production path still calls `::write`; no test callback or mutable hook may enter daemon state.

Add component cases for:

- one complete write;
- repeated partial writes across queue storage;
- partial write followed by `EAGAIN`, then complete recovery;
- `EINTR` before and between successful writes;
- per-pane and global budget exhaustion;
- hard error with the unwritten suffix retained until pane retirement;
- exact-capacity input, one-byte-over-capacity backpressure, and unchanged queue contents; and
- queue allocation release/reuse after drain and pane destruction.

## D2. Real blocked-PTY recovery and ordering

Add `MuxProcessTest.BackpressuresBlockedPtyAndRecoversInOrder` using the deterministic workload
helper:

1. Launch the helper as the focused foreground process and wait for its ready marker.
2. Keep its PTY input unread behind a fixture-owned gate.
3. Send a deterministic payload large enough to exceed kernel PTY buffering and exercise the pane
   queue/client backpressure path.
4. Confirm the pane and attached client remain alive and no input is silently accepted then lost.
5. Open the gate, finish sending under backpressure, and require the helper's exact byte count and
   digest.
6. Send a post-recovery marker to prove the queue returned to ordinary operation.

The sender must tolerate temporary socket `EAGAIN`; it must not create an unbounded in-memory copy or
claim bytes were application-accepted merely because the local socket buffered them.

## D3. Terminal-response ordering

While the helper is gated, make it emit a supported terminal query, then send tagged user input.
After release, assert that the terminal-generated response reaches the helper before the subsequently
accepted user input. This protects the reactor order: PTY drain and response enqueue precede client
input processing.

## D4. Fairness

Add `MuxProcessTest.BlockedPtyDoesNotDelayAnotherPaneOrWorkspace`:

- keep one pane's input side blocked with queued data;
- continuously exchange bounded tokens with another pane or workspace;
- require every token to arrive before its deadline while the first pane remains blocked;
- release the blocked pane and verify its complete ordered digest; and
- repeat with pane iteration order reversed so fairness does not depend on slot zero.

## D exit gate

- [x] Partial write, `EINTR`, `EAGAIN`, hard error, overflow/backpressure, and budgets are deterministic
      component tests.
- [x] A real PTY reaches blocked and recovered states without client detach or pane retirement.
- [x] Accepted data and terminal responses have an asserted total order.
- [x] A blocked pane cannot delay another pane/workspace beyond the bounded test deadline.
- [x] No overflow is silent and queue allocation returns to the aggregate budget after cleanup.

# Workstream E — checked-in end-to-end performance harness

The existing Google Benchmark binary remains the microbenchmark suite. Add a separate process-level
harness for user-visible mux measurements.

## E1. Harness shape

Add a checked-in tool under `tools/` or `benchmarks/mux/` with:

- an 80x24 pseudoterminal;
- isolated runtime/home/config paths;
- explicit warm-up and readiness markers;
- monotonic timestamps;
- bounded raw output capture and byte counts;
- configurable repetitions and absolute per-run timeout;
- JSON output containing host, architecture, Lemma commit/build mode, workload, samples, p50/p95/p99,
  and client bytes; and
- concise human-readable output derived from the same result data.

Build benchmark-owned injected server/CLI drivers when benchmarks are enabled, or factor the existing
test drivers so the release benchmark can use them without enabling GoogleTest. Do not benchmark the
production default endpoint or touch a user's daemon.

## E2. Warm-scroll workload

Reproduce the documented comparison in [`../docs/performance.md`](../docs/performance.md):

- warm multiplexer and attached 80x24 client;
- 25,000 79-column lines, approximately 2 MiB total;
- unique completion marker;
- elapsed time from command submission to marker observation;
- multiplexer-to-client bytes; and
- five repetitions with median plus full sample data.

Lemma is mandatory. tmux, Zellij, and Herdr adapters are optional and must report their exact binary
versions or a clear skip; CI must not require external multiplexers.

## E3. Blocked-PTY latency workload

Measure both:

- key-to-PTY receipt through a fixture-owned side channel from the workload helper; and
- key-to-visible-frame through the attached client output marker.

Collect idle and blocked-other-pane distributions with enough samples for p50/p95/p99. Initially gate
CI on successful bounded completion, sample count, and result validity—not a tight timing threshold.
Record the first reviewed machine-specific baseline in `docs/performance.md`; add a regression budget
only after repeated results are stable.

## E4. CI smoke

Extend `scripts/ci/benchmarks smoke` to run one short Lemma-only process sample in addition to Google
Benchmark. The extended local mode runs the complete repetitions. Preserve JSON artifacts for later
comparison.

## E exit gate

- [x] The warm-session harness and exact workload are reproducible from one documented command.
- [x] Blocked-PTY input and visible-frame latency are both reported against idle.
- [x] Results identify commit, binary, host, workload, samples, and client bytes.
- [x] Cross-multiplexer results are omitted until checked-in adapters can preserve the exact workload.
- [x] `docs/performance.md` no longer contains an unreproducible table.

# Workstream F — resolve the first-release product contract

This is a decision and documentation workstream, not permission to implement P1 features inside P0.
Use one compact decision table in `docs/product-contract.md`. Every row must contain:

- chosen v0.1 behavior or explicit deferral;
- alternatives considered;
- rationale;
- normal and failure behavior;
- compatibility/security implications;
- implementation milestone (`P1`, `P2`, or deferred); and
- tests/documentation required when implemented.

## F1. Invocation and workspace behavior

Decide together:

- what plain `lemma` does;
- whether it attaches, creates, or selects `default`;
- behavior when the default workspace is busy; and
- whether explicit `new`, `start`, and `attach` semantics remain unchanged.

Validate the decision against a five-minute first-session flow; do not optimize only for existing
developer habits.

## F2. Process launch context

Decide together:

- first-pane cwd/environment source;
- split-pane and new-window cwd source/fallback;
- which environment values can refresh on a later client attach;
- payload bounds and filtering for future protocol transport; and
- whether v0.1 supports explicit launch commands or login shells only.

The decision must be implementable without reading another process's mutable environment
unsafely or trusting unbounded client data.

## F3. Durability guarantees

Create a separate guarantee row for:

- normal detach;
- attached-client crash/EOF;
- user logout;
- daemon crash/kill;
- host reboot; and
- planned daemon shutdown.

State process, topology, terminal-state, and scrollback guarantees independently. It is acceptable for
v0.1 to promise no survival across daemon death or reboot; it is not acceptable to imply otherwise.

## F4. Supported platforms and project name

- Select the initial macOS/Linux version and architecture matrix from platforms actually exercised by
  CI and release artifacts.
- Define what “supported” means versus best effort.
- Perform package registry, executable, GitHub, search, and basic trademark-conflict screening for
  “Lemma.”
- Record keep/rename and the evidence date before release URLs and package names become public.

## F5. Input defaults and automation boundary

Decide:

- default prefix and literal-prefix path;
- copy-mode key family;
- whether mouse operation is enabled by default;
- application mouse-capture override modifier; and
- whether first public automation is machine-readable CLI output, local RPC, or CLI over local RPC.

Keyboard completeness and the mouse-native product contract are fixed principles; this decision only
selects defaults and the first public boundary.

## F exit gate

- [x] All 11 TODO decisions have one unambiguous selected answer or explicit deferral.
- [x] No answer contradicts `daily-driver-contract.md`, `roadmap.md`, or current capability labels.
- [x] Implementation consequences are assigned to existing P1/P2 sections without expanding P0.
- [x] README examples and roadmap wording are updated where a decision changes stated direction.

# Workstream G — CI, repetition, and closeout

## G1. Build the process suite in claimed lanes

Update `scripts/ci/platform` and `scripts/ci/sanitizers` so clean builds include:

- `lemma_e2e_tests`;
- `lemma_test_server` and `lemma_test_cli` dependencies;
- the deterministic PTY workload helper; and
- all discovered `integration;pty` tests.

Keep ASan leak detection and UBSan halt-on-error enabled. Do not suppress orphan processes or blanket
exclude process tests. If one platform defect is found, document and fix it or narrow a skip to the
specific demonstrated platform behavior.

## G2. Repetition and cleanup checks

Before closure:

- run each process scenario repeatedly in debug and release;
- run at least one parallel CTest pass to prove endpoint isolation;
- check before/after process lists and runtime directories for orphan server, client, shell, socket,
  lock, gate, or side-channel state;
- run four-platform scheduled validation; and
- run Linux ASan/UBSan with the process suite from a clean build tree.

## G3. Documentation closeout

Update together:

- `TODO.md` — check only scenarios, benchmarks, and decisions meeting this plan;
- `docs/current-capabilities.md` — test counts, adversarial coverage, remaining gaps;
- `docs/roadmap.md` — state that P0 is closed and identify authoritative IDs/versioned protocol as
  next;
- `docs/performance.md` — reproducible commands and labeled results; and
- this file — mark complete and link the next P1 implementation plan.

Correct the stale “60 component tests” baseline while updating counts.

## Required validation

- [x] `just check`
- [x] `just ci-check`
- [x] Debug and release CTest, including all process tests
- [x] Lemma-only benchmark smoke and extended local benchmark
- [ ] Four-platform scheduled suite (merge-time validation)
- [ ] Linux ASan/UBSan process suite (merge-time validation)
- [x] Repeated and parallel process-suite runs without leftovers
- [x] `git diff --check`
- [x] Documentation link check

# Commit sequence

1. **Refactor process support**
   - RAII raw peer, listing parsers, bounded diagnostics; no production behavior change.
2. **Complete topology scenarios**
   - focus, close/zoom, and complete window command coverage.
3. **Complete connection adversaries**
   - fragmentation/coalescing, malformed/disconnect/timeout/capacity, slow readers.
4. **Make PTY flushing deterministically testable**
   - narrow scripted writer seam and component tests; preserve budgets and reactor order.
5. **Add blocked-PTY process stress**
   - gated workload helper, exact recovery/order, terminal responses, fairness.
6. **Check in process benchmarks**
   - warm-scroll and blocked-other-pane latency, JSON output, CI smoke.
7. **Resolve the v0.1 product contract**
   - record all decisions and assign later implementation consequences.
8. **Close P0**
   - CI lane correction, full validation, TODO/capability/roadmap/performance updates.

Each commit must build and pass its applicable component and process tests. Do not mix P1 protocol or
ID-store implementation into the closeout series.

# Review checkpoints

Stop and review before proceeding if:

- a test requires a production-only global switch or mutable timing hook;
- black-box assertions cannot distinguish socket buffering from application acceptance;
- deterministic partial-write coverage depends on kernel timing rather than a scripted seam;
- the PTY helper depends on user dotfiles, a particular shell, or unbounded output;
- a benchmark touches the user's default daemon endpoint;
- process tests are omitted from a claimed platform/sanitizer lane;
- a product decision silently adds a P1/P2 feature to P0; or
- a latency threshold is proposed before stable repeated baselines exist.

# P0 completion gate

P0 may be marked complete only when:

1. all 19 currently open P0 checklist items are checked with evidence;
2. all component and process tests pass on the four claimed host architectures;
3. Linux ASan/UBSan executes the process suite without leaks, orphans, or broad suppressions;
4. malformed, idle, slow, non-reading, and capacity peers cannot stop unrelated PTY progress;
5. a real blocked PTY recovers exact ordered input without detaching the client or retiring the pane;
6. blocked-PTY latency and the warm-scroll workload are reproducible from the repository;
7. every first-release decision is explicit in `docs/product-contract.md`; and
8. the next implementation plan begins with authoritative workspace/pane/client IDs and the
   generalized versioned local protocol.
