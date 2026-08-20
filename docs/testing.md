# Testing and benchmark architecture

## Purpose

Lemma tests mux invariants and Lemma-owned integration contracts. It does not maximize test count and it does not duplicate libghostty-vt's emulator suite.

A test belongs only when it protects a semantic invariant, observable mux behavior, a concrete regression, a compatibility boundary, or a resource/security bound. Every retained test below names the realistic failure it detects.

The intended split is:

```text
GoogleTest            pure C++ invariants and Lemma/libghostty boundary contracts
Python                 real daemon/client/PTY/process behavior
native benchmarks      measured hot loops
Python                 benchmark launch, collection, comparison, and reporting
```

## Baseline before redesign

Measured on 2026-08-18 on the documented Apple M4 Max host, with the debug tree already configured, existing Conan packages, and a warm ccache unless stated otherwise. Raw logs are under `build/test-architecture-baseline/`.

| Measurement | Old result | Method |
| --- | ---: | --- |
| Clean test build | 22.99 s | Fresh debug build tree; test targets only; existing Conan packages and warm ccache |
| No-op test build | 0.07 s | Three native test targets |
| One-TU incremental test build | 0.89 s | Cache-miss edit to `layout_test.cpp`, compile and relink |
| GoogleTest binary build | 1.43 s | All 19 test TUs plus link; production libraries already built; ccache disabled |
| Native unit/component binary runtime | 22.50 s | One `lemma_tests` process, 207 enabled tests |
| C++ mux/E2E runtime | 20.56 s | One `lemma_e2e_tests` process, 43 tests |
| Full CI-style CTest runtime | 38.14 s | Cheap tests at parallelism 4, process tests serially |
| Native benchmark binary build overhead | 0.72 s | Benchmark TU plus link; production libraries built; ccache disabled |
| Release benchmark smoke runtime | 1.79 s | 0.01 s minimum, one repetition |
| Release benchmark default runtime | 32.99 s, failed | Default Google Benchmark timing; `benchmark_terminal_full_frames` exhausted its evolving fixture |

The dominant common-loop defects are not GoogleTest compile time. They are:

1. two scrollback tests consume about 21.0 of the 22.5 unit seconds;
2. the allocation audit consumes about 8.3 seconds, although CTest overlaps it with the slow terminal test;
3. all native domains are linked into one binary and have no useful CTest labels;
4. process behavior lives in a 2,355-line C++ fixture;
5. the default build includes benchmarks;
6. the default benchmark run is long and can fail because measured iterations mutate an ever-growing fixture.

GoogleTest/GMock is not a material build bottleneck: all current GoogleTest translation units compile and link in 1.43 seconds without ccache on this host. GoogleTest remains the native framework.

## Complete current-test audit

Classification means:

- **KEEP**: valuable intent and correct layer.
- **MOVE**: valuable, but not in the common unit tier or not in the right failure domain.
- **REWRITE**: valuable intent, but the current assertion or name overclaims what is proved.
- **DELETE**: trivial, duplicated, misleading, disabled speculation, or no realistic product failure.

There are 253 source-defined C++ test programs/cases: 252 GoogleTest cases plus the standalone allocation audit. A normal non-trace build exposes 252 CTest entries because one trace test is compiled only with tracing enabled. The audit result is 206 KEEP, 18 MOVE, 13 REWRITE, and 16 DELETE before migration; KEEP does not imply keeping the current filename or monolithic binary.

### Frame output and queues

| File | Classification | Tests and bug caught |
| --- | --- | --- |
| `client_frame_output_test.cpp` | KEEP | `RejectsCapacityAndPreservesStorageAfterFailedLifecycleGrowth`, `BoundsAggregateRetainedFrameCapacity`: failed growth must not corrupt retained frames or exceed aggregate memory. `ChunksDeclaredFrameTransactionAtProtocolBoundary`: large frames must retain framing/generation semantics. `BlockedClientRetainsPartialWritesAcrossEintrAndEagain`, `TypedDisconnectRetainsPartialWritesAndDecodesAfterRecovery`: partial socket progress must not duplicate or lose bytes. `FloodedPaneKeepsOneFrameAndCollapsesDamageIntoFullRecovery`: a blocked client must converge from canonical state rather than queue unbounded deltas. `FloodedWritableClientCannotExceedItsPerTurnBudget`, `ManyWritableClientsShareOneGlobalBudget`, `RoundRobinCursorPreventsLowSlotFloodStarvation`: one or many writable clients must not monopolize a reactor turn. `ProgressAndTotalFrameDeadlinesAreBothBounded`: trickling and stalled clients must terminate boundedly. |
| `client_frame_output_test.cpp` | MOVE | `CompositionAndFlushDoNotAllocateFrameStorage`: valuable steady-state allocation evidence, but it belongs with the native allocation/performance tier rather than ordinary correctness. |
| `client_frame_output_test.cpp` | REWRITE | `SizesFrameForRendererBoundAndComposesAlternatingStyles`: it only proves the resulting byte count fits; it does not prove styled composition. Retain a focused worst-case frame-capacity proof and leave semantic style projection to convergence tests. |
| `connection_output_test.cpp` | KEEP | `RetainsPartialWritesAcrossEagainAndRecovers`: control responses must survive partial writes and EAGAIN without reordering. |
| `pty_writer_test.cpp` | KEEP | All eight cases. They protect partial progress, terminal-response-before-input ordering, resize-generated mode-2048 replies entering the write queue, EINTR attempt bounds, per-pane/global fairness budgets, hard-error suffix retention, reusable bounded storage, and rejection of impossible writer progress. |
| `core_test.cpp` | KEEP | `BoundedByteQueueTest.*`: wraparound order, contiguous segment ownership, capacity reuse, and all-or-nothing append are direct queue invariants. |

### Core, identity, layout, input policy, and scheduling

| File | Classification | Tests and bug caught |
| --- | --- | --- |
| `core_test.cpp` | KEEP | `DispatchesValidatedBoundedValue`, `DispatchesTypedOneCellResizeCommand`, `RequiresAttachmentIdentityForInteractionCancellation`, `DispatchesGenerationSafeDividerResizeCommand`, `RejectsInvalidValuesBeforeExecutor`: malformed or under-scoped commands must never reach mutation. `TabOrderIsOneBoundedStableIdPermutation`: reorder must not duplicate/drop stable tab IDs. `RenameAndTabTitleValuesAreBoundedAndValidated`: invalid names/control bytes must not mutate authoritative names. All three `CopyModeCoreTest` cases protect phase-specific key reduction and viewport placement policy without terminal dependencies. `GenerationalIdTest.InvalidUntilCreatedFromValidParts` and `BoundedGenerationalStoreTest.RejectsStaleIdsAndReportsCapacity` prevent stale IDs from resolving reused slots. |
| `core_test.cpp` | MOVE | `BoundedGenerationalStoreTest.DeterministicChurnNeverRevivesStaleIds`: useful deterministic generated coverage, but it belongs in the stress/state-machine tier. |
| `core_test.cpp` | REWRITE | `ValidatesTypedRenameReorderAndSwapPayloads`: one broad happy-path test obscures which target/payload invariant failed. Replace with a compact table of accepted and rejected command shapes. |
| `core_test.cpp` | DELETE | `SessionModelTest.ConstructsPureSemanticHierarchyAndAttachment`: it mostly verifies getters return constructor arguments and public fields retain assigned values. It catches no realistic mux transition failure. |
| `layout_test.cpp` | KEEP | The first eleven cases protect exact split geometry, persistent ratios, divider hit/capture identity, absolute nested coordinates, total non-overlapping projection, structural minimums, nearest-ancestor resize, sibling promotion, leaf-only swap, and maximum bounded topology. These catch zero-sized/overlapping panes, stale divider retargeting, and topology corruption. |
| `layout_test.cpp` | MOVE | `FixedPointRatioRoundTripsEverySupportedOneCellBoundary`: exhaustive and valuable, but its roughly 0.52-second sweep belongs in deterministic stress; a small representative boundary table remains in unit. |
| `input_router_test.cpp` | KEEP | All 20 cases. Compile-time map rejection protects unique/resolved/bounded contexts, invalid `encode_as` targets, and `encode_as` chords that would collide with legacy matching. Router cases protect deferred-prefix replay, escape-sequence batching, one-shot/transient lifetime, held-key ownership, modifier normalization, replaceable host copy/line-motion chords, press-time `encode_as` remembered through release, resize-context consume of line-motion chords, and direct bindings. These prevent leaked prefixes, replayed input, and commands firing in the wrong Attachment context. |
| `frame_scheduler_test.cpp` | KEEP | All eight cases. They protect input/write causality, deadline monotonicity, burst/display cadence, blocked-sink convergence, resize full-redraw promotion, detach cancellation, and absence of idle timers. |
| `core_input_test.cpp` | KEEP | All nine cases. They test the consequence of terminal modes at the queue boundary: typed key/paste/alternate-scroll encoding, prefix ordering, and atomic rejection under backpressure. |

### Protocol and host decoding

| File | Classification | Tests and bug caught |
| --- | --- | --- |
| `protocol_test.cpp` | KEEP | The two byte goldens protect the private wire ABI. Host-theme, typed input, large paste, live theme, and resize-command round trips protect schema coverage. Fragment/coalescing tests protect stream decoding. Borrowed-message repetition protects lifetime until `consume`. Malformed/value/generation/oversize tests protect authority before payload mutation. Typed disconnect protects diagnosable failure. |
| `protocol_test.cpp` | REWRITE | `EncodesBoundedControlContextSize`: one arbitrary value does not establish the variable-width integer contract. Replace it with zero/minimum, representation transitions, maximum, and malformed cases. |
| `host_input_parser_test.cpp` | KEEP | All seven cases. They protect typed event boundaries under every fragmentation point, distinct wheel axes/buttons, Kitty metadata and special-key actions, associated text, and lossless fallback for malformed/unknown sequences. |
| `host_terminal_theme_test.cpp` | KEEP | All five cases. They protect fragmented OSC replies, exact passthrough of non-theme bytes, bounded storage reuse, OSC 17/19 highlight replies, and the complete bounded query surface. |
| `extension_test.cpp` | KEEP | The three extension protocol cases and three `ExtensionRuntimeTest` cases protect bounded stream decoding, typed encode errors, nonblocking ownership, transactional generation publication, and bounded-turn continuation. `IgnoresRelativeConfigRoots` protects trust-boundary path resolution. |
| `extension_test.cpp` | MOVE | `LoadsFullLuaAndRegistersBoundedGenerationOutOfProcess`, `ReportsDeterministicLuaQuotaFailureWithoutRestarting`, `ReportsEmptyLuaErrorWithoutRestarting`: these spawn real hosts and belong in serialized extension process integration, not the unit binary. |
| `latency_trace_test.cpp` | KEEP | All three source cases protect exact marker correlation, recovery from oversized candidates, append-only event ordering, and one-time correlation. The mmap case remains conditional on trace-enabled builds. |

### Terminal and rendering boundary

| File | Classification | Tests and bug caught |
| --- | --- | --- |
| `terminal_test.cpp` | KEEP | `RejectsInvalidAndUnfundedConfigurations`; damage cases; caller-owned screen formatting; pending-wrap format replay; changed-row/span/scroll rendering; grapheme convergence; resize mapping; key, key-release fallback including identified legacy releases, application-cursor, focus, mouse, alternate-scroll, and paste mode consequences; graphics disable policy; sticky response overflow; truthful identity/geometry responses; mode-2048 enable and resize reports; typed effects; tracked selection/copy movement/wide-cell/normalization/viewport/search/checkpoint/reflow/highlight contracts; and allocator accounting. Each exercises a Lemma-owned assumption through only Lemma public types. |
| `terminal_test.cpp` | MOVE | `PinnedLibraryBuildInfoMatchesProductionContract` to dependency integrity. `GrowsAndPrunesScrollbackUnderItsOwnerQuota`, `DefaultScrollbackRetainsMultipleGhosttyPages`, and `CompressesScrollbackIncrementallyWithoutChangingLogicalContent` to extended terminal/resource tests. The two scrollback cases alone consume about 21 seconds in debug. |
| `terminal_test.cpp` | DELETE | `PreservesPositionalTerminalOptionMembers`: aggregate member order is an implementation detail, not a supported ABI. Callers should use designated initialization. |
| `render_composition_test.cpp` | KEEP | All 24 cases. They protect atomic multi-pane placement, bounded status/edit/copy overlays, shared status render/hit geometry, overflow visibility, incremental status/pane damage, declared separators and junctions, focused outer-mode ownership, mouse-capture projection, suspended layout clearing, non-overlap/focus validation, and output bounds. Exact byte assertions are retained only where ANSI presentation is Lemma's contract; mode tests also parse the composed consequence. |
| `ghostty_parity_regression_test.cpp` | KEEP, then MOVE/rename | `M2EraseLineTailPreservesSessionBackground`, `M2PaletteRedrawDoesNotImitateTerminalScroll`, `M2AnsiProjectionIsolatesPaneColorOverrides`, `M2ThemeReplacementPreservesApplicationOverrides`, `M2SynchronizedOutputIsGatedPerPane`, `M2SynchronizedOutputWatchdogPreservesCanonicalMode`, `M2FrameTransactionAbortRepairsPhysicalShadow`, and the three resize transaction cases. These are real terminal/render/runtime contracts, but “parity” and milestone prefixes hide their failure domains. |
| `ghostty_parity_regression_test.cpp` | REWRITE | `M2SessionThemeSurvivesReattach` performs no detach or reattach; rewrite as a terminal render-invalidation contract plus a real process detach/theme scenario. `M2AnsiProjectionPreservesSemanticColorsAndCursor` barely checks cursor reset and overclaims semantic convergence; rewrite as Ghostty→Lemma ANSI→Ghostty visible-state convergence. |
| `ghostty_parity_regression_test.cpp` | DELETE | `DeclaredGeometryFitsBoundedFrameTransaction` duplicates the authoritative frame-capacity calculation. `SecurityAndProgressLimitsMatchM0Policy` checks arbitrary constants against themselves. `M3HostInputDecoderAcceptsEveryFragmentationBoundary`, `M3PasteIsOpaqueAndUsesGhosttyEncoder`, `M3KittyMetadataIsPreservedWithoutFabrication`, `M3MouseUsesReadTimeGeometryAndPaneLocalCoordinates`, `M3EffectsAreBoundedAndPolicyRouted`, `M4SelectionAnchorsTrackTerminalMutation`, and `M5AnsiProjectionConvergesForCombiningCharacterScroll` duplicate stronger named tests elsewhere. `DISABLED_M7KittyGraphicsLifecycleIsBoundedAndClipped` is a speculative `FAIL()`, not a regression. |

Misleading names in this file are the clearest current audit defect: “reattach” never reattaches, “parity” mixes security limits, host decoding, runtime resize, rendering, selection, and disabled future graphics, and milestone labels do not identify concrete bugs.

### Platform and real mux process cases

| File | Classification | Tests and bug caught |
| --- | --- | --- |
| `platform_test.cpp` | MOVE | `ReadsForegroundProcessName` is valuable platform behavior but opens a PTY and forks; move to serialized platform integration. |
| `e2e_mux_test.cpp` | KEEP | `CommitsShutdownWhenControlPeerDisconnectsBeforeAcknowledgement`; launch environment/CWD cases; `CreatesAttachesRendersAndDetaches`; typed Kitty and structured paste/focus/mouse routing; pane click focus; status tab click/create and drag-preview/commit; shell mouse selection and Super+c copy of the selected payload; Super+c with no selection does not copy; Super+Left Home rewrite; alternate-screen wheel consequence; settled outer resize; full-redraw generations; focus/swap routing; transient resize context; persisted split ratio; copy reflow; search preview/direction; copy state after client loss; pane close/zoom with child PIDs; rename/reorder/tab lifecycle; daemon-loss restoration; final-shell teardown; fragmented/coalesced setup; typed malformed/version recovery; terminal-response ordering; and idle/non-reader/capacity isolation. These exercise real daemons, clients, children, PTYs, and observable completion. |
| `e2e_mux_test.cpp` | MOVE | `KeepsChildAndGhosttyGeometrySynchronizedDuringLiveDividerOutput`, divider/context floods, broad signal/blocked-output restoration, 2 MiB blocked PTY recovery, and 500-resize output flood. They are valuable adversarial/stress cases and should not slow the common mux loop. |
| `e2e_mux_test.cpp` | REWRITE | `ProvidesDefaultInvocationHelpVersionErrorsAndShutdown` mixes CLI text, session behavior, and shutdown. `DragsBothSeparatorAxesThroughTypedResizeCommands`, `HandlesMouseEdgesCopyTransitionsAndDeletedCaptureTargets`, `WheelScrollsWithoutCopyModeAndApplicationInputFollowsOutput`, `PreservesTopologyAcrossResizeAbruptExitAndReattach`, and `CopyModeHighlightsSelectsCopiesAndIsolatesInput` each combine several independently diagnosable contracts. `RejectsMalformedAndDisconnectingSetupAndReusesSlots` hides a five-second idle timeout inside otherwise fast malformed cases. `SlowControlAndInitialAttachReadersRecoverWithoutBlockingPtys` explicitly admits the control reader may never become slow, so its name overclaims the observed condition. Split these into minimal Python scenarios with direct observable waits. |
| `steady_state_allocation_audit.cpp` | MOVE | It protects zero warmed allocations across routing, parse/damage/composition/frame flush, and resize. Keep as native performance/resource evidence, outside ordinary unit and mux commands. |

The 43 old C++ process cases classify as 29 KEEP, 6 MOVE, and 8 REWRITE. During migration, KEEP means preserve the behavior, not preserve the C++ fixture.

### Python support and automation tests

`benchmarks/benchmark_tools_test.py` is control-plane contract coverage, not product unit coverage. Keep its statistics, completion/failure, host-scope, latency-correlation, marker uniqueness, shell-fixture, soak-report, ANSI tracker, and PTY cleanup cases. Move the four `PtyProcessBufferingTest`/`AnsiScreenTrackerTest` concerns into shared Python test-support ownership when the mux harness is extracted; benchmark orchestration should consume that tested support rather than own a second PTY implementation.

Keep all `tools/test_ci_changes.py` cases. They protect selective CI lane routing and remain automation tests, separate from product `unit` and `mux` results.

## Benchmark audit

| Benchmark | Decision | Performance question |
| --- | --- | --- |
| `benchmark_greeting` | DELETE | No hot path or regression value. |
| `benchmark_command_dispatch` | KEEP | Cost per typed semantic command. |
| Four input-router benchmarks | KEEP | Cost of ordinary runs, context commands, typed forwarding, and repeats on the per-input path. |
| Layout projection 1/4/16/64 and worst depth | KEEP | Scaling and adversarial topology projection. |
| Layout resize/swap/divider hit/divider candidate | KEEP | Interactive structural command cost at maximum supported topology. |
| Live divider PTY resize and composed resize 2/4/16/64 | KEEP | Kernel notification and reflow/composition portions, explicitly separate. |
| Extension registration codec | DELETE | Configuration-time work is neither frequent nor currently performance-sensitive. Remove its host budget. |
| Private attach input codec | KEEP | Per-message protocol overhead on the input path. |
| Terminal small/large writes | REWRITE | Parsing throughput matters, but the current loop evolves unbounded screen/history state. Keep fixture state equivalent between samples. |
| Terminal render update | DELETE | It overlaps the more useful ANSI damage scenarios and has no output/completion metric. |
| Styled damage, one-row, scroll, viewport wheel | KEEP | Sparse, scroll, and historical redraw costs plus bytes/frame. |
| Multi-pane composition 1/4/16/64 | KEEP | Multiplicative dirty-pane composition cost and bytes/frame. |
| Full frame | REWRITE | Full reconstruction matters, but the current fixture grows until the default benchmark fails. Measure a stable populated frame. |
| `terminal_memory.cpp` | KEEP | Native terminal/frame/history memory census, with Python only summarizing. |
| Python mux workloads | KEEP, tier | Warm scroll, attach-visible, key-to-PTY/visible, idle resources, blocked PTY/client, pane profiles, lifecycle churn, and F5/soak answer user-visible questions. Smoke must run Lemma only; cross-mux comparison and long profiles belong to explicit extended runs. |

Native benchmark loops remain in C++. Python starts binaries, checks exact completion, collects raw samples, compares distributions, and reports p50/p95/p99, bytes, CPU, RSS, descriptors, and wakeups. No Python operation is placed inside a microbenchmark loop.

## Final taxonomy and commands

Conceptual ownership, even where several cases share one C++ translation unit:

```text
tests/
  unit/
    core/
    layout/
    protocol/
    queues/
    input/
    scheduling/
  terminal_boundary/
    configuration/
    parse_damage/
    render_convergence/
    input_encoding/
    effects_responses/
    selection_search/
    resize/
  mux/
    pane_lifecycle/
    session_lifecycle/
    resize/
    input/
    output/
    backpressure/
    copy_mode/
    terminal_boundary/
  regressions/
  stress/
  support/
```

The developer entry point should support:

```sh
./test                         # fast unit + terminal-boundary + core mux scenarios
./test unit
./test layout
./test protocol
./test terminal
./test mux
./test mux pane-lifecycle
./test mux detach-reattach
./test mux resize
./test stress
./test extended

./bench                        # short native smoke
./bench terminal
./bench layout
./bench mux
./bench --compare main
```

CTest remains authoritative for CI integration. Cheap native binaries carry `unit` or `terminal` labels and may run in parallel. Real process tests carry `mux;integration` and run serially when contention invalidates the scenario. Stress, allocation, dependency, sanitizer, and extended suites are explicit labels and do not enter the common edit loop.

## Missing mux failure-domain coverage

Current high-value gaps, separated from unsupported product features:

- **Pane lifecycle:** no minimal real-process case proves swap preserves both child owners and responsiveness; child-exit coverage is embedded in a broad resize stress case; no FD census accompanies final teardown.
- **Session lifecycle:** no test produces child output while genuinely detached and then proves the reattached client sees canonical current state. Existing “reattach” terminal tests do not do this.
- **Multi-client:** intentionally unavailable under current one-controller policy. Do not fake it. When product policy changes, add two-client disconnect, resize/view isolation, slow-reader isolation, and fresh-baseline reconnect scenarios before calling the feature working.
- **Resize:** horizontal and vertical real geometry exist, but a minimal nested split geometry case and an observable reflow-convergence case are absent. Current live-divider geometry proof belongs in stress.
- **Input:** full-path application-cursor mode consequence is absent. Bracketed paste, Kitty keys, focus, mouse, and alternate-scroll have real paths.
- **Output:** no minimal styled-output isolation case spans child→PTY→Ghostty→composition→client; simultaneous independent pane output and real synchronized-output release are absent.
- **Backpressure:** blocked PTY and non-reading client isolation are strong. Memory/queue-depth evidence during pressure is benchmark-only, and differing-speed multi-client coverage awaits product support.
- **Copy/search:** alternate-screen policy, stale match after history mutation, and resize during an active in-progress search need focused scenarios.
- **Resources:** teardown checks child PIDs in one case but does not systematically census leaked child processes and descriptors.

## Missing Lemma/libghostty-vt boundary coverage

The current boundary suite is already substantial. The remaining Lemma-owned gaps are:

1. full mux consequence of application-cursor mode changing encoded input;
2. full mux synchronized-output isolation and release/watchdog presentation;
3. styled output and explicit/default/palette color isolation through pane composition and client observation;
4. resize/reflow semantic convergence through a real child and PTY, not only adapter state;
5. session theme/default propagation across a genuine detach/reattach lifecycle;
6. explicit automated enforcement that only `lemma_terminal` includes Ghostty headers;
7. upgrade qualification that runs dependency integrity, terminal, mux boundary scenarios, memory census, and selected benchmarks as one named lane.

Dependency integrity already has a strong configure/build foundation: exact commit, clean source, Zig version, optimization mapping, feature defines, source-local output avoidance, and a patch ledger. Runtime product tests should not duplicate these checks.

## Python mux harness design

The harness owns orchestration only and uses the production test server, CLI, and native deterministic PTY peer.

```text
LemmaServer
  owns isolated runtime directory, environment, daemon process, logs, cleanup
  creates Session objects and runs bounded CLI observations

Session
  owns a stable session name, topology observations, attach/detach/destroy operations
  returns Pane handles when a focused child PID is observed

Pane
  identifies the observed child PID and session
  focuses generation-safely through observable state, splits, sends, closes, checks liveness

Client
  owns one real outer PTY and attached CLI process
  sends bytes/keys, resizes, tracks ANSI-visible state, detaches, and checks restoration
```

Every wait uses a monotonic deadline and an observable descriptor, process state, socket state, CLI state, or decoded screen condition. Deliberate timing stimuli such as an outer-resize gesture may use controlled spacing; correctness synchronization may not use arbitrary sleeps.

On timeout or assertion failure, diagnostics include:

- server and client process IDs/status;
- daemon log tail;
- client raw output tail and reconstructed screen;
- latest session listing/topology;
- requested outer geometry;
- failing command and its stdout/stderr;
- expected condition and timeout;
- generated seed and operation log when applicable.

## Native unit strategy

- Keep GoogleTest and use ordinary `EXPECT_EQ`, `EXPECT_TRUE`, and `ASSERT_TRUE` by default.
- Build a pure unit binary that cannot link terminal, platform PTY, daemon, or subprocess owners.
- Build a focused terminal-boundary binary linked only to Lemma's terminal/render/runtime boundary dependencies.
- Keep process-opening extension/platform tests in separate serialized component binaries.
- Run a native binary once for the developer command; retain per-case GoogleTest discovery for CTest filtering/reporting.
- Move expensive exhaustive/resource cases out of the unit label.
- Prefer semantic convergence over brittle ANSI byte equality except where framing or a specific emitted sequence is the contract.

## Deterministic stress/state-machine design

Two state machines are useful and have different ownership:

1. **Pure Core/layout machine:** deterministic split, focus-model, resize, divider move, swap, and remove sequences. After every operation validate topology, ID liveness, pane uniqueness, structural minimums, complete non-overlapping projection, and stale-handle rejection.
2. **Real mux machine:** deterministic split, focus, input, resize, close, detach, reattach, and output operations against actual children. After applicable operations validate pane count, focused PID liveness, closed PID exit, unaffected-child responsiveness, positive PTY geometry, detach persistence, terminal restoration, and final process/FD cleanup.

The seed comes from a fixed default and an override. Failure output contains the seed, complete operation log, failing index, latest topology, PIDs, geometry, screen, and daemon logs. Sequence minimization is an explicit stress-runner feature, not work in the common test loop.

## Incremental migration order

1. Establish labels/targets and the single developer entry point without changing production behavior.
2. Remove trivial smoke tests/benchmarks and the fake parity dumping ground; move unique contracts under terminal/render/resize ownership.
3. Move slow scrollback, allocation, platform, extension-process, and generated cases out of `unit`.
4. Extract tested Python PTY/screen support and add focused pane/session lifecycle Python scenarios, including real detached output.
5. Port the remaining KEEP C++ process behavior by failure domain; split broad REWRITE cases and retire the giant fixture only after behavioral replacement.
6. Add deterministic pure and real-mux state machines to `stress`.
7. Stabilize benchmark fixtures, remove non-questions, separate smoke/mux/comparison tiers, and preserve raw-distribution reporting.
8. Re-measure the same clean build, incremental build, native unit, mux, full, and benchmark commands. Do not claim completion until the old/new table and retained behavior matrix are both reviewed.

This order keeps each change reviewable and prevents a framework rewrite from silently deleting behavior.

The measured result of the first migration slice is recorded in [`testing-results.md`](testing-results.md).
