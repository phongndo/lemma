# Lemma performance mission

This is the requested live execution checklist for the performance mission. Update it after every
reviewable slice. Raw generated reports stay under `build/`; this file records only status, decisions,
and stable report locations.

Status: `[x]` complete, `[~]` in progress or partially complete, `[ ]` not started, `[!]` blocked by
a failed gate or an explicit product decision.

## Permanent gates

Every retained change must preserve equivalent terminal semantics, response-before-input ordering,
resize ordering, bounded work and storage, detached correctness, failure behavior, and fairness under
blocked PTYs/clients. Correctness failures are disqualifications. Performance claims require a valid
approved host, calibrated A/A noise, raw distributions, and complete process/resource boundaries.

For each optimization record:

1. equivalent work and semantics;
2. the current resource owner and multiplier;
3. hypothesis and selected metric;
4. ordering, lifetime, failure, resize, detached, and backpressure risks;
5. A/B evidence and collateral effects;
6. retain, revise, or remove decision.

## Milestone A — trustworthy Linux baseline

- [~] Reproduce the approved-host extended comparison, memory census, deterministic budgets, and
  regression budgets.
  - Revision: `a45cba10dd9b892a57a0aac2433aaa22ec33cf75`.
  - Host: approved `box`, AMD Ryzen 9 9950X, policy affinity `0-7`.
  - Reports: `build/linux-baseline/`.
  - Deterministic budgets passed. Thirteen pre-existing absolute regression targets failed.
- [x] Calibrate A/A noise.
  - The original run failed because the discrete p95 interaction-byte tail moved from 94 to 412
    bytes when one autonomous frame crossed the marker. The stable p50 (93 bytes in every capture)
    is now the paired gate; the stochastic p95 remains reported as a diagnostic rather than hidden.
  - Passing report: `build/performance/calibration-a-stable-bytes/calibration.json`.
  - Original failed report: `build/performance/calibration-20260903T043445Z/calibration.json`.
- [x] Generate the initial category scoreboard and correctness-qualified summary.
  - `build/linux-baseline/current-linux-scoreboard.{json,md}`.
- [x] Stabilize the interactive-output paired byte gate without suppressing the observed tail.
- [~] Add Linux process-tree PSS, private clean/dirty, anonymous/shared/swap/peak, faults, schedstat,
  context-switch, wakeup/readiness, thread/stack, byte/syscall, and optional separate `perf stat`
  evidence.
  - `/proc/PID/{smaps_rollup,schedstat,status,stat,io}` now supplies PSS/private/anonymous/shared/
    swap/peak memory, CPU/runqueue time, faults, context switches, thread and stack totals, process I/O
    bytes, disk bytes, and I/O syscall counts for the complete tree and direct roles.
  - `benchmarks/perf_stat.py` adds separate reviewed hardware/cache/software counter groups; example
    evidence is under `build/linux-perf/`. A reviewed Linux per-process wakeup source remains.
- [~] Add all-active P1/P2/P4/P8/P16/P32/P64 and mixed-activity workloads.
  - A shared start gate now arms every Pane with the same bounded 81-byte/1 ms producer while one
    focused producer preserves correlated interaction endpoints.
  - Approved-host Lemma/tmux reports: `build/linux-all-active/{lemma,tmux}.json`.
  - Mixed 1%/10%/50% activity remains.
- [~] Add cold start/attach/resync, multiple Session/workspace, viewer-scale, history-scale,
  capability, soak, remote, and GUI-lab workloads as their prerequisites become available.
  Extended 20-sample S1/S2/S4/S8/S16 Session and W1/W2/W4/W8/W16 workspace profiles now pass under
  `build/performance/h-{session,workspace}-profiles-extended.json`. V1/V2/V4/V8/V16/V32/V64 viewer
  scale with one stalled observer passes under `build/performance/e-viewer-scale-shared-screen.json`,
  and Ghostty history/cap/decommit scale is qualified under
  `build/performance/g-ghostty-page-pool.json`. A 1,000-cycle, 16-Pane, 5.1-minute park/hydrate soak
  passes on the current release source under
  `build/performance/k-parking-hydration-soak-1000-latest-source.json`. Capability, remote, and
  GUI-lab coverage remain; remote is explicitly deferred.
- [x] Regenerate a publication-qualified scoreboard with randomized order, direct brackets,
  confidence intervals, practical effects, raw failures, and stock versus normalized separation.
  The generated JSON retains all raw samples, the seeded 47-phase execution order, direct before/
  after controls and drift, deterministic 5,000-resample 95% bootstrap intervals, and practical
  p50 effects. Only correctness-complete results rank. Normalized 80x24 results are separate from an
  explicit unavailable stock GUI-lab section; seven competitor failure records remain visible.
  Evidence: `build/release/k-publication-scoreboard.{json,md}`; reproducer:
  `benchmarks/publication_scoreboard.py`.

## Milestone B — Ghostty candidate and feature matrix

- [x] Add explicit validated `-Dvt-features` plumbing.
  - Profiles: `full`, `trimmed`, `minimal`, and `minimal-snapshot`.
  - Production remains explicitly `full`; no production semantic change.
  - Generated manifests validate archive symbols and pin metadata.
- [x] Add a reproducible profile matrix for archive/executable size, retained memory, and native
  terminal microbenchmarks.
  - `just ghostty-feature-matrix`.
  - Reports: `build/ghostty-feature-matrix/`.
  - Trimmed-equivalent profile saved 217,446 stripped archive bytes, 160,864 stripped executable
    bytes, and 336 tracked bytes, but small writes regressed 11.5%; do not promote it yet.
- [x] Establish the minimal capability set.
  - At the current pin, tracked selection checkpoints require Ghostty's snapshot feature, so
    `trimmed`, `minimal`, and `minimal-snapshot` are capability-equivalent. Those profiles remove
    only Kitty graphics and glyph-protocol support from `full`; the retained terminal adapter needs
    snapshot, formatter, selection, render state, input encoding, color, and grid introspection.
- [x] Extend the matrix with section/relocation data, P1/P64 memory, parser corpus coverage, packed
  row/render operations, reflow, and snapshot encode/READY/full-restore measurements.
  The refreshed four-profile matrix records section files, 5,552 full versus 5,467 reduced-profile
  relocations, P1/P4/P16/P64 empty/history/clear PagePool measurements, parser corpus, reflow, packed
  renderer operations, and snapshot READY/full restore. PagePool memory is identical across
  profiles. Reduced profiles are 169,056 stripped executable bytes smaller and 2.4-3.1% faster in
  reflow, but regress small-write parsing from 41.8 ns to 44.0-44.7 ns (5.3-6.9%) in this run; the
  earlier matrix measured an 11.5% regression. Snapshot encode/READY/full restore remain effectively
  tied, so production stays `full`. Evidence: `build/ghostty-feature-matrix/results-extended.json` and its referenced
  per-profile raw reports.
- [x] Inspect the 2026-09-03 upstream candidate `31bdcd5a79639bbac97c1a94e0f41d0f5ff84ca2`,
  its 355 intervening commits, unchanged Zig 0.16 requirement, API changes, and empty local patch ledger.
- [x] Atomically build and evaluate that candidate, including its new synchronous clipboard reply API
  and a zero-byte limit for unsupported Kitty clipboard transactions; then restore all pins together.
  - Boundary/resource/simulation tests and deterministic budgets passed.
  - Report: `build/ghostty-candidate-31bdcd5/results.json`.
  - It added 19.2% to the stripped Lemma binary, 152 retained bytes and one allocation at initial
    render, 8.0% to small-write CPU, and 8.4% to wheel-frame CPU.
- [x] Reject this candidate: its unsupported capability breadth and practical critical-path
  regressions do not justify promotion. Continue evaluating later candidates from the retained pin.

## Milestone C — low-risk memory owner removal

- [x] Replace `Terminal::Impl`'s inline 64 KiB PTY-response queue with a synchronous borrowed sink
  into the Pane's existing bounded ordered PTY write queue.
  - Required replies enter the one ordered path before later input; missing, over-limit, and
    rejecting sinks fail the Pane closed.
  - `Terminal::Impl` fell from 84,304 to 18,768 bytes (`-65,536`, 77.7%); P1/P2/P4/P8/P16/P32/P64
    sampled daemon PSS fell by 61,440/126,976/266,240/462,848/999,424/2,252,800/4,440,064 bytes.
  - Reports: `build/release/c3-response-sink-ownership.json`,
    `build/linux-all-active/c3-response-sink-lemma.json`, and
    `build/performance/c3-response-sink-micro.json`.
  - Terminal medians remained within 2.3% of the prior full-profile run; P64 correlated interaction
    p50 moved +2.0% and p95 -8.4% in independently sampled 20-repetition runs.
- [x] Remove both fixed 8 KiB row-hash arrays from every terminal: make current-row hashes
  operation-scoped render scratch and co-locate retained row hashes in the existing right-sized
  physical-projection allocation.
  - `Terminal::Impl` fell again from 18,768 to 2,776 bytes; default external projection storage
    increased by only 192 bytes, for a net 15,800-byte saving beyond the response-sink slice.
  - Relative to baseline, sampled daemon PSS fell 81,920/163,840/331,776/544,768/1,228,800/
    2,621,440/5,885,952 bytes at P1/P2/P4/P8/P16/P32/P64.
  - All terminal microbenchmark medians stayed within 1.7% of the preceding response-sink build.
  - Reports: `build/release/c3-terminal-ownership.json`,
    `build/release/c3-terminal-memory.json`,
    `build/linux-all-active/c3-terminal-ownership-lemma.json`, and
    `build/performance/c3-terminal-ownership-micro.json`.
- [x] Lazily/right-size large cold Session and connection storage without moving allocation into a
  steady-state pane/frame path.
  - Immutable CWD/environment launch context now uses exact creation-time allocations; `Session`
    fell from 85,152 to 15,528 bytes.
  - Detached Sessions retain no client-decoder payload allocation; `ClientDecoder` fell from 8,312
    to 112 bytes and `AttachmentRuntime` from 9,072 to 872 bytes. Attach p50/p95 improved from the
    original 0.985/1.123 ms diagnostic baseline to 0.842/0.925 ms.
  - Pending setup fields initially kept 4 KiB inline while control output grew lazily;
    `PendingConnection` fell from 144,208 to 9,072 bytes and `ConnectionOutput` from 65,552 to 32
    bytes. Moving create-only CWD and greater-than-64-byte protocol fields behind lifecycle-funded
    allocations then reduced `PendingConnection` to 936 bytes without changing common short-field
    parsing.
  - S16 daemon PSS fell 2,542,592 bytes (28.0%) versus baseline. Reports:
    `build/release/c3-cold-storage-ownership.json`,
    `build/memory/c3-cold-runtime-session-profiles.json`, and
    `build/performance/c3-cold-runtime-attach.json`.
- [x] Rerun the complete debug and 301-test production suites, terminal/mux/blocked-PTY
  integration, steady-state allocation audit, memory census, and approved-host
  micro/attach/session evidence after the independent owner changes. Final publication gates remain
  in Milestone K.

## Milestone D — latency and renderer

- [x] Complete correlated stage traces from outer input through client-visible output and separate
  queueing from CPU execution.
  - The marker grammar now matches the fixture's six-byte token. Current 100-sample continuous and
    TUI traces each correlate 100/100 measured paths with zero dropped events.
  - Reports: `build/performance/d-retained-trace-interactive-report.json` and
    `build/performance/d-retained-trace-tui-report.json`.
- [x] Add bounded urgent input-correlated and autonomous coalesced scheduling lanes without busy
  polling, starvation, or an unbounded urgency flag.
  - Interactive/state-change damage still bypasses delay. Autonomous output waits 3 ms initially,
    6 ms while a short burst continues, and 16 ms after 50 ms; an armed deadline is never postponed.
  - The original repeated 25k-row probe reused one completion marker and could match a delayed
    repaint from the preceding iteration. Completion markers are now indexed; the corrected
    100-sample result is 15.69/22.07/22.35 ms p50/p95/p99 with 604 median outer bytes.
- [x] Prototype ABI-manifest-validated packed Ghostty row/cell access behind the terminal boundary.
  - Construction validates content, codepoint, style, width, RGB, palette, and styling fields
    against the exact linked type descriptor and representative typed getters before direct decode.
  - Raw rows are bulk borrowed; typed style/grapheme access remains the exceptional path.
- [~] Prove packed-render equivalence for style, Unicode, wrapping, cursor, palette, hyperlink,
  alternate screen, scroll, reflow, resize, and partial damage.
  - Terminal/compositor tests cover complete graphemes, palette and selection context, partial-damage
    hash refresh, ANSI round trips, alternate screen, resize, hardware scroll, and hyperlink text
    convergence without leaking unsupported OSC 8 state. The current full ASan/UBSan suite, extended
    simulations, allocation audit, and bounded parser fuzz campaigns pass; full binary snapshot
    restore coverage stays in Milestones F and K.
- [~] Maintain ready Pane and dirty row sets; remove ordinary capacity scans and redundant hashing.
  - Row-level selection, raw-row bulk access, semantic style caching, prehashed physical styles, and
    reuse of precomputed full-frame hashes remove per-cell calls and duplicate hashing. An
    uninitialized grapheme-scratch prototype improved renderer diagnostics but had inconsistent
    process tails and was reverted. The retained revision instead initializes one buffer per row and
    reuses only getter-reported prefixes. Renderer medians improve 10-22%; across three fresh
    200-sample pairs, aggregate TUI p50/p95 improve 8.7%/3.0% and aggregate continuous-output
    p50/p95 improve 2.1%/~0%. Evidence: `build/performance/grapheme-uninit-{paired,process-paired}/`
    and `build/performance/row-scratch-{tui,continuous}-paired/`.
  - A dense live-Pane owner prototype reduced paired PMAX active CPU p95 from 26.02 to 23.87 ms but was
    reverted after an adverse warm-scroll diagnostic. The old repeated warm probe was subsequently
    found to permit stale-marker matches, so that comparison is diagnostic rather than valid
    retention evidence; any revised owner design needs a new indexed-marker gate. Evidence:
    `build/performance/h-dense-panes-paired-gate/`.
- [~] Measure and reduce PTY parser calls, reads, framing, flushes, and partial-write overhead with
  bounded per-turn fairness.
  - The current PTY drain remains bounded to four 64 KiB reads per turn. A short-read return
    prototype halved daemon read syscalls from about 1,932 to 972 per second in five-sample active
    diagnostics but did not improve P1 CPU and its paired gate hit the known warm-scroll tail; it was
    removed rather than retained without end-to-end evidence. Consecutive changed rows use compact
    relative movement. A two-iovec `sendmsg()` prototype removed one client send syscall but
    regressed continuous-output p50 by 2.8% and 4.2% in two 100-sample ABBA pairs and had mixed
    collateral tails, so it was reverted. Evidence:
    `build/performance/h-pty-short-read-profiles-smoke.json`,
    `build/performance/h-pty-short-read-final-paired-gate/paired-regression.json`, and
    `build/performance/sendmsg-paired/`.
  - Retain one bounded transport write for multiple mouse envelopes decoded from the same physical
    read. Two 200-sample ABBA pairs reduced wheel p50 from 192/196 to 172/181 us and p95 from 242/244
    to 216/216 us; attached-client CPU fell 27-28%. Envelope ordering and sequence semantics remain
    individual. Evidence: `build/performance/mouse-batch-paired/`. Broader framing work remains.
- [~] Beat or tie calibrated tmux p50/p95 for continuous output, TUI redraw, wheel, and attach while
  retaining open-loop latency, output suppression, zero warm allocations, and idle wakeups.
  - Retained paired evidence versus `HEAD` passes: styled damage 110,592 -> 22,205 ns, single row
    2,696 -> 1,174 ns, scroll 58,832 -> 9,622 ns, full frame 59,090 -> 15,460 ns, and continuous
    interactive p50/p95 149/196 -> 82/115 us. Report:
    `build/performance/d-retained-paired-gate/paired-regression.json`.
  - A temporary status-region scroll optimization was removed after it increased paired 25k-row
    p50/p95 wire bytes; status remains protected by disabling outer scroll below chrome.
  - The final seeded randomized comparison has valid p50/p95, direct brackets, and all failures
    visible. In that 20-sample run Lemma leads attach (767/878 versus 1,064/1,125 us), wheel
    (136/161 versus 172/214 us), and indexed 25k-row completion (15.72/16.17 versus 22.33/22.71 ms);
    tmux leads continuous output, open-loop, and TUI redraw. Evidence:
    `build/release/k-final-mux-comparison.json`.
  - Higher-count final samples make p99 valid. Lemma leads tmux wheel p50/p95 at 166/207 versus
    171/208 us after mouse batching. tmux still leads continuous output at 36/58 versus 76/120 us
    and TUI redraw at 153/185 versus 166/220 us. Open-loop PTY delivery favors Lemma at 75/238
    versus 89/266 us p50/p95; outer visibility splits p50/p95 at 128/363 versus 111/381 us.
    Evidence: `build/release/k-final-*-{lemma,tmux}-200.json`.
  - At 100 indexed warm-scroll samples, Lemma records 15.67/16.20/16.27 ms p50/p95/p99 and 604
    median outer bytes versus tmux at 22.48/23.23/28.54 ms and 966,627 bytes. Evidence:
    `build/release/k-final-warm-scroll-{lemma,tmux}-100.json`.
  - Composed terminal rows now use `CSI K` for trailing blanks only when the Pane reaches the outer
    content viewport's physical right edge. Left Panes retain explicit bounded cells and cannot erase
    neighboring surfaces; standalone rendering is unchanged. In the retained exact-source gate this
    reduced attach p95 from 2,653 to 807 bytes and warm-scroll p50/p95 from 1,006/1,324 to 547/681
    bytes. Evidence:
    `build/performance/h-pane-work-deadlines-line-erase-paired-gate-v3/paired-regression.json`.

## Milestone E — shared presentation and observers

- [x] Allocate presentation storage only for viewed Sessions.
  Attachment frame storage is lifecycle-owned and released on detach; public screen scratch/cache is
  allocated only when a capture or screen observer first requires it.
- [~] Compose one immutable bounded generation and share it across viewers.
  Public screen observers now share one bounded daemon cache keyed by Session, Pane, and observation
  generation. The first observer formats canonical terminal state; subsequent observers encode only
  their sequence-bearing Event envelope from the cached bytes. Private ANSI attachments still need a
  generalized immutable Session `FrameBlob` before multiple terminal viewers can exist.
- [x] Reduce per-viewer state to role, generation/sequence, offset, deadline, and resync state.
  Create-only CWD storage and greater-than-64-byte setup fields are lifecycle-funded indirect owners,
  reducing `PendingConnection` from 9,072 to 936 bytes. Admission now transfers a passive Event
  socket into a dedicated `PublicObserver` and immediately releases all setup, create, attach,
  decoder, and Proc fields. At V64, marginal daemon private-dirty ownership is 2,816 bytes per
  observer, CPU is 548 us/update, and p95 visibility remains below 15 ms with one stalled observer.
  Evidence: `build/performance/e-viewer-scale-dedicated-observers.json`. The preceding setup-storage
  compaction and paired gate remain at `build/performance/e-viewer-scale-compact-observers.json` and
  `build/performance/e-compact-observer-paired-gate/paired-regression.json`.
- [x] Enforce one explicit controller and passive observers with ordered controller transfer.
  A Session admits one attached controller; public observers have no mutation path. Four-observer
  integration coverage verifies identical generation and screen content.
- [x] Benchmark 1/2/4/8/16/32/64 viewers, including one stalled viewer.
  With one stalled observer, all active viewers completed 20 measured updates. Daemon CPU per update
  scaled from 119 us at V1 to 586 us at V64 (63 active recipients), p95 visibility stayed below
  16 ms, and daemon private-dirty ownership stayed near 11.5 KiB per observer. Evidence:
  `build/performance/e-viewer-scale-shared-screen.json` and reproducible
  `benchmarks/viewer_scale.py`.

## Milestone F — snapshot primitives and parking

- [x] Add a Lemma-owned Ghostty snapshot adapter with explicit encoded/decoded limits and READY-first,
  incremental-history interfaces.
  - Complete and READY-first restore share the quota allocator, terminal policy, callbacks, and
    helper ownership used by fresh construction. Input/output is capped at 64 MiB, continuation is
    opt-in before input and capped at 1 MiB, each incremental call consumes at most one history page,
    and FINISH must consume the exact borrowed source.
- [~] Test complete terminal state, unfinished continuation, corruption/truncation/version/order,
  allocation/I/O/cancellation failures, and pin-specific invalidation.
  - Current boundary tests cover visible and historical content, styles, complete graphemes,
    palettes, OSC 8 hyperlinks, modes, primary/alternate screens, title/PWD, terminal replies,
    resize, unfinished VT
    and UTF-8, READY progress, CRC corruption, CRC-valid record reordering, truncation, unsupported
    version, trailing bytes, geometry mismatch, quota failure, and decoder cancellation. Automatic
    parking integration now also corrupts Ghostty payload bytes before sealing and verifies a
    non-retryable `pane_restore_failed` result followed by deterministic failed-Pane reclamation.
    The pinned Ghostty format does not restore tracked selection; sizing and encoding now reject an
    active selection instead of silently changing selection/style projection, and automatic parking
    retains the live terminal. A streaming
    reader/I/O-failure
    adapter was rejected after deterministic Debug heap corruption when a callback-restored terminal
    was rendered and another restore began; the reproducer and controls are recorded in
    `build/performance/f-snapshot-streaming-blocker.json`. Resolve that ownership interaction before
    exposing streaming restore.
- [x] Encode typed `Active -> Parking -> Parked -> Unparking -> Active` transitions.
  - `PaneRuntime` now owns one inline active terminal through `PaneResidency`; larger cold states are
    allocated only on transition. Parking rollback retains the live terminal, unpark cancellation
    retains the sealed snapshot, wake reasons are a bounded bitset, and restoration advances by one
    Ghostty history page per call.
- [~] Park detached/invisible Panes without consuming post-snapshot PTY bytes; coalesce bounded wake
  reasons and define deterministic failure ownership.
  - Quiet live Panes in detached, unobserved Sessions now become eligible after a five-minute
    production delay. Parked PTYs now observe output/HUP/ERR readiness and request wake without
    consuming bytes; hydrating PTYs leave the readiness set until complete. Attach holds its reservation
    through bounded one-page hydration, terminal-dependent automation initiates wake and reports
    retryable `pane_hydrating`, and legacy input/capture/topology controls wake before returning
    unavailable. Restore failure fails the Pane, while parking admission/storage failure retains the
    live terminal and retries only after another quiet interval. Deterministic short-delay lifecycle
    coverage exercises legacy/public capture retries, public input exact-once retry, observer
    exclusion, attachment transfer, re-parking, post-snapshot and stalled PTY output ordering, held
    child exit, corrupted automatic restore, and destruction. Failed restore/viewport/theme preparation now releases its attach
    reservation before flushing the bounded disconnect diagnostic. A bounded deterministic-test
    hydration pause proves that disconnect during `prepare_attach` releases the reservation before
    another attachment acquires it; the race-free case passed ten repeated runs. Parking invisible
    Panes in attached Sessions remains evidence-gated.
- [~] Qualify authenticated ephemeral snapshot storage, quotas, atomic replacement, cleanup, and
  crash behavior.
  - `pane_snapshot_storage` now uses libsodium secretstream authenticated encryption with locked,
    wiped per-snapshot keys. Plaintext exists only in operation-owned anonymous mappings, wiped on
    release. The approved threat model excludes transient plaintext swap/live-memory/dump exposure;
    plaintext backing files are not permitted. Checked ciphertext writes replace writable file
    mappings and synchronous durability flushes. See `docs/architecture.md` for the physical storage,
    descriptor, kernel cache, key, and hydration-peak boundaries. Per-Pane (64 MiB), per-Session
    (256 MiB), and daemon (1 GiB) payload reservations remain unchanged. Linux storage tests cover
    randomization, ciphertext tampering, chunk reordering, truncation, trailing bytes, and I/O failure;
    platform and performance qualification of this repair is not complete.
- [!] Qualify large-snapshot and parking/failure storms against unrelated-Session interaction budgets.
  - Lifecycle-owned quiet deadlines suppress unrelated-turn parking scans; due attempts are
    round-robin and capped at one Pane per turn, with failure retries measured from completion.
    This does not bound a single synchronous sizing/encode/encrypt/I/O/decrypt operation. No claim
    of foreground isolation or mission completion is made by these repairs. The maximum-size storage
    round-trip diagnostic is approximately 111 ms (`build/pr12-repair/encrypted-storage-micro.json`),
    not a foreground-interaction result. A single bounded ownership-transfer worker is authorized
    for the next repair; `platform::spawn_process` currently performs environment/NSS work after
    `forkpty`, which must be made safe before introducing a daemon thread.
  - Linux `nix develop -c just check`, `nix develop -c just ci-check`, release tests, simulation, and
    `nix build .#lemma` pass for this repair slice. The 20-cycle/four-Pane resource diagnostic returns
    to zero descriptor/process/backing-file deltas. A/A calibration passes on approved `box` under
    `build/performance/pr12-repair-calibration/`. Candidate macOS and paired A/B qualification remain
    separate gates; adding ARM/Intel PR jobs is not evidence they have passed.
  - Debug lifecycle repetition exposed oversized vector stores in Zig 0.16.0's x86-64 Debug
    snapshot encoder. Valgrind evidence is `build/pr12-repair/valgrind.log`; Debug now uses checked
    LLVM ReleaseSafe for Ghostty, with the same dependency pin/features. This does not independently
    resolve the earlier streaming-restore experiment. Current repair checks and diagnostics live
    under `build/pr12-repair/`; the existing F/K performance reports predate these repairs.
- [~] Benchmark active versus parked PSS, disk bytes, park/READY/full latency, peak hydration memory,
  first action/output/attach/capture/resize, backpressure, density, and churn.
  - On approved host `box`, 16 detached 5,000-row Panes reduced daemon PSS from 58,328,064 to
    4,369,408 bytes (92.51%) while 16 sealed mappings occupied 6,619,136 virtual bytes (413,696 per
    Pane). Full hydration plus a fresh legacy capture process measured 2.535/3.708 ms p50/p95;
    attach through hydration and first visible frame measured 3.898/4.210 ms p50/p95. All mappings
    were released and restored PSS was 59,485,184 bytes. Evidence:
    `build/performance/f-parking-probe-sealed-final.json` and reproducible
    `benchmarks/parking_probe.py`. A three-sample all-active diagnostic refreshed P1/P4/P16/PMAX;
    PMAX recorded 190,575,616 total PSS, 508,488,991 ns CPU, and 85,479 ns interaction p50 in
    `build/performance/f-parking-all-active-profiles.json`. A valid approved-host three-sample
    extended diagnostic now covers P1/P2/P4/P8/P16/P32/P64; p50 process-tree PSS scales from
    9,446,400 bytes at P1 to 190,345,216 bytes at P64, while interaction p50 remains 52-85 us.
    Evidence: `build/performance/f-parking-all-active-profiles-extended.json`. Sample count is
    insufficient for p95/p99 qualification. A separate valid 50-cycle
    create/attach/split/close/detach/kill run held daemon descriptors/process count at 8/2 and
    converged to a zero-byte final RSS range and zero-byte/cycle slope; evidence:
    `build/performance/f-parking-lifecycle-churn.json`. A separate approved-host 40-Pane run supplied
    20 capture samples: fresh capture-command-to-Ghostty-READY retry acknowledgement measured
    1.097/2.736 ms p50/p95, full capture hydration 2.013/4.448 ms, and attach through first visible
    frame 4.087/4.581 ms. During a second hydration pass, 212 daemon-PSS samples at a nominal 0.5 ms
    interval observed no transient excess above the 141,154,304-byte fully restored state; all
    mappings were released. A new high-rate companion collected 1,357 `/proc/PID/statm` RSS samples
    at a nominal 50 us interval plus 210 PSS samples while hydrating 40 Panes. PSS again never
    exceeded the 142,909,440-byte restored state; RSS peaked only 376,832 bytes above its
    146,575,360-byte restored sample, and all mappings were released. Evidence:
    `build/performance/f-parking-ready-peak-40-high-rate.json` and
    `build/performance/f-parking-ready-peak-40.json`; the earlier 16-Pane diagnostic remains in
    `build/performance/f-parking-ready-peak.json`. The paired 80x23,
    5,000-row in-process microbenchmark isolates Ghostty READY at 84.1/106.3 us p50/p95 and complete
    restore at 470.4/481.0 us over 20 repetitions; evidence:
    `build/performance/f-snapshot-ready-full-micro.json`. The complete approved-host paired gate
    against `HEAD` passes every regression comparison, including blocked PTY/client fairness,
    active/idle P1/P4/P16/P64, warm scroll, attach, interaction, renderer, and RSS/CPU checks.
    The final exact-source rerun records P64 active RSS p95 falling from 421,998,592 to 416,591,872
    bytes and interaction p50/p95 at 81.5/149.3 us versus 78.5/110.9 us, within the calibrated
    absolute gate. Evidence:
    `build/performance/f-parking-paired-gate-final/paired-regression.json`; the preceding run remains
    under `build/performance/f-parking-paired-gate/`. A 50-cycle 16-Pane park/hydrate churn run
    completed with 29.9/32.0 ms p50/p95 aggregate hydration latency, negligible PSS/private-dirty
    slopes, zero final descriptor/process/mapping deltas, and zero final memory range/slope. Evidence:
    `build/performance/f-parking-hydration-churn.json`; reproducer:
    `benchmarks/parking_churn.py`.
  - A 1 KiB continuation-cap diagnostic did not reduce active P1/P4/P16/PMAX PSS (PMAX was
    190,604,288 versus 190,575,616 bytes); disabling tracking entirely saved only 294,912 PMAX bytes
    (0.15%) while making automatic parking invalid. Both weaken unfinished-sequence coverage, so the
    1 MiB bound remains. Evidence: `build/performance/f-parking-continuation-{1k,zero}-all-active.json`.
- [x] Consider attached-controller parking only if detached/invisible evidence passes.
  Decision: do not enable it. Detached parking passes, but no attached/invisible projection gate yet
  proves that snapshot eligibility, active selection, synchronized output, and immediate focus/resize
  transitions remain latency-neutral. Attached Sessions therefore stay active; this avoids adding a
  Pane-capacity scan or wake transition to ordinary controller turns.

## Milestone G — active terminal memory floor

- [x] Account actual Ghostty PagePool address space, committed bytes, allocator charges, and decommit
  behavior.
  A purpose-built process probe holds 0/1/4/16/64 terminals at empty, 5,100-row history, immediate
  clear, and one-second-settled clear stages while `/proc/<pid>/smaps` accounts anonymous mappings.
  Empty 80x24 terminals scale exactly at 2,134,016 anonymous writable virtual bytes and 45,056
  resident/private-dirty bytes each, plus 15,392 bytes through Ghostty's callback allocator. With a
  5,000-line history cap, 5,100 rows raise those values to 5,025,792 virtual, 3,063,808 resident,
  and 18,950 callback-allocator bytes per terminal. CSI 3 J immediately decommits 2,695,168 bytes per
  terminal but retains the 5,025,792-byte virtual reservation and a 368,640-byte resident floor.
  Evidence: `build/performance/g-ghostty-page-pool.json`; reproducer:
  `benchmarks/ghostty_page_pool_probe.py` and `lemma_terminal_memory_probe`.
- [x] Request the smallest supported configuration and avoid unmeasured preheat/touch behavior.
  Caps of 0, 1, 100, and 5,000 lines all retain the same empty 2,134,016-byte virtual and 45,056-byte
  resident anonymous floor. The first three converge to 344,064 resident bytes after the history
  workload and do not decommit on clear; only the 5,000-line configuration grows extra virtual
  pages. Lowering the cap therefore cannot reduce active-empty ownership and would only remove
  user-visible history semantics.
- [~] Prototype compact/shared/COW pages and shared daemon PagePools with upstream Ghostty rather than
  an indefinite private fork. A source-isolated compact-page prototype changed only Ghostty's
  standard capacity from 215x215 to 128x128. At P64 it cut active-empty virtual ownership 59.3% but
  cut active-empty RSS only 9.1%; after 5,100 rows it increased virtual ownership 44.9%, RSS/private
  dirty 15.4%, and reflow median CPU 3.6%. It is rejected and production remains untouched. Shared
  or COW ownership still needs an upstream lifetime/mutation design; no local wrapper can safely
  emulate it. Evidence: `build/performance/g-ghostty-compact-128-prototype.json` and its raw sources.
- [~] Re-run larger all-active, idle, mixed, history, and restore scales; report any semantic floor
  that prevents tmux-class active-empty density.
  Exact P1/P4/P16/P64 empty/history/clear scaling and the existing all-active and restore profiles
  identify Ghostty's 2.04 MiB per-terminal virtual PagePool reservation and 44 KiB initial committed
  anonymous floor as dependency-owned. Deterministic PMAX mixed-activity runs now cover 1%, 10%, and
  50% active Panes: Lemma daemon CPU is below tmux at all three points, but process-tree RSS remains
  higher and grows with active Ghostty history. An upstream shared/COW PagePool and larger restore
  scale still remain. Evidence: `build/performance/h-mixed-activity-{status-cache-lemma,tmux}.json`.

## Milestone H — reactor scale

- [x] Replace ordinary owner/capacity scans with live readiness, dirty-owner, and bounded deadline
  structures. `PaneRuntimeStore` owns an intrusive, generation-safe live-Pane registry plus balanced
  failure/hydration counts, a pending-write possibility bit, and minimum parking, presentation, and
  compression deadline hints. Work-arm sites tighten the corresponding hint immediately; a reached
  conservative stale minimum performs one bounded refresh. `Sessions` retains lifecycle-maintained
  dense live, attached-controller, and pending-frame-work registries over its generational identity
  store. Pending connections, observers, public Proc executions, and capacity rejections maintain
  authoritative dense live-slot registries: stable protocol indices remain sparse, while ordinary
  descriptor, service, cleanup, and deadline passes are O(live owners). Turn-local
  read/input/message/geometry budgets initialize only live Session slots, and the 64 KiB PTY read
  buffer is write-before-read rather than cleared on every ready PTY. Reactor time is sampled once
  per pre-poll and post-poll phase, with an explicit refresh across the blocking boundary; child
  collection runs only after readiness on its wake descriptor. Status invalidation no longer
  recomputes the complete signature for every PTY event. The fresh V1–V64 observer sweep keeps every
  p95 below 15 ms and reduces daemon CPU per update by 9–52% versus the preceding report; V64 is
  432,839 ns/update and 2,880 private-dirty bytes/viewer. Middle-slot Session, attachment, and
  observer integration coverage verifies swap removal without losing retained work.
  Evidence: `build/performance/e-viewer-scale-dense-owners.json` and
  `build/performance/h-pane-work-deadlines-line-erase-paired-gate-v3/paired-regression.json`.
- [~] Compare current `poll()` with Linux epoll and Darwin kqueue at safe 1–4096 descriptor scales.
  Linux now retains one persistent activity-aware epoll queue for eight or more descriptors. Every
  descriptor ownership lifetime has a nonzero identity, so numeric-fd reuse cannot inherit a stale
  registration; add/delete/mask changes reconcile before sparse waits, while the prior turn's 25%
  ready density selects `poll()` without epoll's dense-event penalty. Any synchronization failure
  resets the queue and falls back to `poll()`. Approved-host medians for adaptive versus poll are
  107 versus 768 ns idle, 143 versus 769 ns at 1% readiness, and 784 versus 769 ns fully ready at 64
  descriptors; at 4,096 they are 4.81 versus 48.8 us, 5.54 versus 48.9 us, and 49.9 versus 49.0 us.
  Darwin kqueue execution evidence remains unavailable. Evidence:
  `build/performance/h-reactor-{backends,adaptive}-linux.json`.
- [x] Compare one reactor, active-only dedicated PTY threads, and bounded shards while charging
  measurable stack, scheduling, throughput, and tail costs.
  Dedicated idle workers reserve 8,392,704 virtual bytes and commit about 8.6 KiB private-dirty per
  thread; extrapolating the measured exact reservation to 4,096 Panes is 32.0 GiB before
  kernel-owned stacks. Waking and joining 512 workers costs 3.54 ms. Serial epoll shards multiply
  empty waits: at 4,096 descriptors, one/two/four/eight shards cost 37/73/144/293 ns idle,
  709/788/886/1,087 ns at 1% readiness, and 88.9/94.8/95.4/96.6 us fully ready. Kernel memory,
  RAPL energy, and Darwin scheduler evidence are reported unavailable rather than estimated.
  Evidence: `build/performance/h-reactor-{thread-topology,epoll-shards}-linux.json` and reproducible
  topology/benchmark probes.
- [x] Retain only a backend that preserves P1 behavior and improves relevant scale/fairness.
  Decision: retain the adaptive Linux epoll backend and `poll()` elsewhere. The R64 production
  profile observed one epoll queue with 67 live registrations and zero daemon CPU across three idle
  one-second windows. The latest exact-source gate passed all 72 enforced comparisons after the Pane
  work/deadline hints and right-edge EL pass. Active CPU p95 changed from 12.86 to 6.27 ms at P1,
  10.29 to 6.65 ms at P4, 13.12 to 5.96 ms at P16, and 25.37 to 6.98 ms at PMAX versus `HEAD`.
  Attach p95 is now 807 bytes and the blocked-client fairness ratio is 0.751, removing both earlier
  absolute failures. Seven product targets remain: P1/P4/P16/PMAX active aggregate CPU, P16 active
  RSS, and PMAX idle/active RSS. One preceding capture retained a stochastic warm-scroll p95 failure
  at 21.39 versus 17.27 ms; the complete repeat passed at 16.30 versus 15.77 ms, consistent with the
  previously recorded bimodal diagnostic. Dedicated threads and serial shards remain rejected.
  Evidence: `build/performance/h-reactor-production-r64-linux.json`,
  `build/performance/h-adaptive-epoll-final-paired-gate/paired-regression.json`, both
  `build/performance/h-live-owner-final-paired-gate{,-2}/paired-regression.json` reports,
  `build/performance/h-dense-aux-owners-paired-gate/paired-regression.json`, and both
  `build/performance/h-pane-work-deadlines-line-erase-paired-gate-{v2,v3}/paired-regression.json`.

## Milestone I — binary and release profile

- [~] Explicit Ghostty feature profile and reproducible stripped/unstripped size evidence exist.
- [x] Produce section, symbol, relocation, and link-map ownership reports.
  - `build/release/i-binary-ownership.json` records section bytes, 5,523 dynamic/PLT relocations,
    largest symbols, and allocated link-map bytes by archive owner; raw section, symbol, relocation,
    and map reports sit beside it.
- [~] Remove unreachable adapters/tables and verify section garbage collection.
  - Link-only `--gc-sections` reduced the stripped executable from 3,096,568 to 2,975,088 bytes and
    was microbenchmark-neutral, but inconsistent process latency did not qualify it for retention.
    Per-function/data sections saved more space but regressed hot renderer diagnostics.
- [x] Evaluate LTO/thin-LTO, deterministic stripping, and split debug information with runtime and
  build-time evidence.
  - Thin-LTO required the matching LLVM archive/link tools, used 890,880 KiB peak RSS for the measured
    build, and reduced stripped size only to 3,056,520 bytes. It regressed scroll microbenchmarks by
    8.3%, so it is not retained.
  - After the retained snapshot adapter, deterministic split debug produced a 2,988,536-byte
    executable plus an 8,032,216-byte debug file; two independent splits were byte-identical. The
    supported stripped executable is 3,106,520 bytes, 9,952 bytes above the pre-adapter artifact.
    Evidence: `build/release/i-split-debug.json`.
  - The parking/observer-integrated ordinary release executable was 3,135,592 stripped bytes,
    39,024 bytes above the pre-snapshot 3,096,568-byte artifact. After the retained dense
    Session/auxiliary-owner registries, adaptive reactor, parking, Pane work hints, right-edge EL,
    and qualification additions, the exact latest-source ordinary executable is 3,279,232 stripped
    bytes: 143,640 bytes above that preceding artifact and 182,664 bytes above the pre-snapshot
    artifact. The schema-v2 release record captures the effective Release/test/benchmark/trace/Ghostty
    configuration and a canonical SHA-256 manifest over all tracked and untracked source files,
    failing on a dirty source submodule. Evidence:
    `build/release/k-final-binaries-latest-source.json`. Original evidence:
    `build/release/k-final-binaries-nonremote.json`; the preceding parking-only record remains at
    `build/release/k-final-binaries-parking.json`.
- [x] Retain production Ghostty `full` (`+all`) at the pinned revision; smaller profiles and Thin-LTO
  remain rejected by their recorded runtime regressions, and latency tracing is disabled.

## Milestone J — secure remote and extension ecosystem

- [!] Build transport-neutral bounded resync semantics before exposing a network transport. Remote
  work is explicitly deferred while local performance, scale, and publication gates finish.
- [x] Obtain an explicit product decision among SSH, TLS/TCP, and QUIC gateway trade-offs.
  Decision: defer remote qualification; keep `AF_UNIX` local-only and do not invent cryptography.
- [!] Add authenticated encrypted reconnect, replay protection, quotas, priority separation, and the
  required RTT/bandwidth/jitter/loss/recovery matrix in an external gateway after remote work is
  resumed.
- [~] Extend versioned Commands, immutable bounded Events, supervised jobs, compiled policy, package
  capabilities, and declarative views without daemon hot-path callbacks. Public
  `lemma.proc/v1` Commands/results and passive `lemma.events/v1` subscriptions are implemented with
  bounded validation, ordered execution, immutable snapshots/Events, no replay log, and no observer
  mutation path. Compiled policy and one isolated resident Lua generation are also implemented.
  Supervised jobs, package capabilities, and declarative extension views remain.
- [~] Prove idle extensions add no PTY/frame work and slow/crashed/flooding extensions cannot delay
  terminal progress or retain unbounded data. A configured, blocked Lua host generated zero CPU and
  zero daemon writes over twenty 200 ms windows; it added one process and 291,840 process-tree PSS
  bytes in this run. Killing the host after compilation leaves key dispatch and Pane output live.
  Slow/flooding future command/event/job channels cannot be qualified before those channels exist;
  the current host has no daemon hot-path callback or event input. Evidence:
  `build/performance/j-extension-isolation-linux.json` and
  `ConfigurationMuxTest.test_compiled_policy_survives_extension_host_crash`.

## Milestone K — publication-quality final sweep

- [~] Pass clean production build, tests, formatting, lint, sanitizers, fuzz/stress, backpressure,
  detach, resize, snapshot, viewer, remote, and soak gates. Build/correctness/sanitizer/fuzz/
  backpressure/detach/resize/snapshot, 1–64 viewer, and 1,000-cycle parking soak gates pass on the
  exact source; GUI remains unavailable while remote is explicitly deferred.
- [x] Run valid before/after approved-host checks and a seeded randomized extended comparison with
  direct brackets. Evidence: `build/performance/d-retained-paired-gate/`,
  `build/performance/f-parking-paired-gate-final/`,
  `build/performance/h-live-owner-final-paired-gate{,-2}/`,
  `build/performance/h-dense-aux-owners-paired-gate/`,
  `build/performance/h-pane-work-deadlines-line-erase-paired-gate-v3/`, and
  `build/release/k-final-mux-comparison.json`.
- [~] Publish generated correctness-qualified latency, throughput/wire, memory/PSS, CPU/perf,
  allocation, Pane/Session/workspace/viewer/history scale, binary, and 1,000-cycle parking stability
  evidence under `build/`; remote and GUI qualification remain unavailable.
- [x] Reproduce the full working patch from a detached fresh checkout.
  `CLANGD_JOBS=4 just check` passed after applying the tracked diff and every untracked source file
  to revision `a45cba10dd9b892a57a0aac2433aaa22ec33cf75`. The current worktree, including untracked source,
  subsequently passed `nix build path:.#default --print-build-logs` after the Pane work/deadline and
  right-edge EL changes. Plain `nix build .#default` intentionally sees only Git-indexed files and
  cannot qualify an uncommitted worktree containing new source files.
- [x] Verify every Definition-of-Done category or report the exact semantic/resource floor without
  changing workload boundaries. The machine-readable review preserves all seven failed absolute
  targets from the selected latest gate, the unsupported Linux wakeup target, comparative
  sustained-output/TUI/RSS floors, and unavailable stock-GUI/Darwin evidence. It reports milestones
  D/E/G/H/J/K as partial or deferred rather than promoting them. Evidence:
  `build/release/k-definition-of-done.{json,md}`; reproducer:
  `benchmarks/definition_of_done.py`.

## Current verification

Passed on the latest source after the right-edge EL and authoritative Pane work/deadline-hint pass:

```text
just check: passed, including formatting, lint, Debug tests, and 51 benchmark-tool tests
Release configure: tests and benchmarks ON, latency tracing OFF, Ghostty profile full
ctest --preset release: 316/316 passed
scripts/ci/sanitizers: passed, including ASan/UBSan extended and integration suites
LEMMA_FUZZ_CAMPAIGN_SECONDS_PER_TARGET=60 scripts/ci/fuzz-campaign: all three campaigns passed
lemma_steady_state_allocation_audit: 10,000 ordinary and 10,000 resize iterations; zero general or
  terminal-quota allocations
nix build path:.#default --print-build-logs: passed against tracked and untracked latest source
binary-size schema v2: Release configuration and canonical source manifest captured; `lemma` is
  3,279,232 stripped bytes
approved-host `h-pane-work-deadlines-line-erase-paired-gate-v3` against `HEAD`: all 72 enforced
  comparisons passed; seven absolute product targets remain separately visible as failures
rejected PTY short-read experiment: syscall diagnostic retained and exact paired failure retained;
  implementation reverted
latest-source 1,000-cycle 16-Pane park/hydrate soak: zero final descriptor, process, and snapshot
  mapping deltas; zero final PSS/private-dirty range and slope
V1–V64 dense-owner observer sweep: all generations converged, all observers remained bounded, every
  p95 stayed below 15 ms, and daemon CPU/update improved 9–52% versus the preceding report
first live-Session paired capture: one warm-scroll p95 comparison failed; retained as raw evidence
  rather than hidden, with the complete repeat and pooled 200-sample result recorded above
R64 production profile: one epoll queue, 67 registrations, 73 total descriptors, and zero daemon CPU
  in all three idle one-second windows
git diff --check: passed
```

Passed after the feature-profile slice:

```text
just check
just ci-check
nix build path:.#lemma --no-link
scripts/ci/deterministic-budgets
focused dependency and terminal boundary suites
benchmark Python tests
```

Latest retained renderer/scheduler gate:

```text
scripts/performance gate HEAD build/performance/d-retained-paired-gate
# renderer and non-warm paired checks passed; its repeated warm-marker result is superseded by the
# indexed final reports because a delayed prior repaint could match the former constant marker
LEMMA_ENABLE_LATENCY_TRACE=OFF in the final release configuration
```

Latest production qualification on the retained source:

```text
LEMMA_BUILD_TESTS=ON
LEMMA_ENABLE_LATENCY_TRACE=OFF
ctest --preset release: 307/307 passed
scripts/ci/deterministic-budgets: passed
just check: passed after final benchmark-marker, hyperlink, row-scratch, and snapshot-adapter changes
extended final memory/profile sweep: passed after tmux profile setup moved from racing prefix chords
  to its control boundary; `build/release/f3-memory-summary.json`
seeded randomized 20-sample comparison plus indexed 100-sample warm and 200-sample interaction
  runs: passed validation
nix build path:.#lemma --no-link: passed on the snapshot-adapter source
scripts/ci/sanitizers: passed after the snapshot adapter, including ASan/UBSan extended suites,
  allocation audit,
  3 bounded libFuzzer campaigns, and a 16,384-operation generated mux simulation
```

Known failed gates are tracked above and must not be silently reclassified as passes.
