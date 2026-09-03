# Development

## Design quality

Lemma treats performance as a product property, not post-hoc tuning. Prefer designs with one clear
owner, direct data flow, bounded work, and few states. Encode invariants in types and construction so
invalid states are difficult or impossible to represent. Preserve ordering and failure semantics at
boundaries. Add abstraction or hot-path complexity only when it makes the system simpler or
measured evidence justifies it.

Apply these principles:

1. **Make the correct state representable.** Use types, construction, and ownership instead of
   comments and defensive synchronization.
2. **Keep one authority per fact.** Derive views rather than maintaining competing state.
3. **Bound operational behavior.** Storage, work, queues, retries, waiting, and failure need explicit
   limits.
4. **Prefer the direct design.** Fewer owners, transitions, copies, and abstraction layers are easier
   to reason about and usually faster.
5. **Keep the fast path simple.** Avoid filesystem work, process inspection, allocation, formatting,
   and redundant terminal queries in per-byte, event, pane, frame, or client paths.
6. **Measure consequential costs.** Benchmarks justify complexity; they do not substitute for
   correctness.

Elegance is not the number of abstractions. It is how few states and transitions are needed to
express the complete behavior.

## Workflow

Enter the development environment and use the shared development runner:

```sh
nix develop
just run --version
just run pane split --right

# The shell command is an ergonomic alias for the same runner.
lemma --version
lemma pane split --right
```

`just run [args...]` is the canonical explicit entry point. Both forms configure `build/dev` only
when its toolchain or configuration inputs change and issue an incremental build of only the
`lemma` target. For bare `lemma`, `lemma new`, and `lemma start`, the runner supplies the directory
where it was invoked when `--cwd` is omitted; it otherwise executes that checkout's exact binary
with unchanged arguments. The `dev` profile uses `-O1`, debug symbols, enabled invariants, and frame
pointers. C and C++ outputs are path-normalized into the user's shared ccache, so matching
compilations are reusable across worktrees even after removing `build/`; `just clean` preserves that
cache, while `just clean-cache` explicitly clears it. A path-derived runtime namespace isolates every
worktree, and the runner replaces a daemon whose executable predates the current build.

Common verification commands:

```sh
./test unit
./test mux resize
./test mux pane-lifecycle
just test              # fast native and real-mux tests
just fmt               # format C++, Nix, and Python
just fmt-check
just lint
just lsp-check
just python-check
just check             # build, formatting, analysis, tests, and Python checks
just ci-check          # all merge-blocking CI lanes
```

The verification profile defaults to `debug`. Release is explicit and remains the authority for
production validation, packaging, and performance measurements (`just bench`, `just mux-bench`,
`nix build .#lemma`). Run a focused check while working and `just check` before completing a
substantial change.

## Tests

The default suite separates deterministic component behavior from real process behavior:

| Tier | Responsibility |
| --- | --- |
| Native unit | Core values, commands, layout, protocol, queues, configuration, and input policy |
| Terminal boundary | Ghostty adapter, rendering, input encoding, effects, resize, and selection |
| Component integration | Process-opening platform boundaries |
| Python mux | Real daemon, client, PTY, child process, lifecycle, API, and terminal consequences |
| Simulation/stress | Deterministic Core and Ghostty worlds, real-mux state machines, history, and allocation evidence |

Use the repository entry point:

```sh
./test
./test unit
./test layout
./test protocol
./test input            # Lua configuration generation and native settings/input policy
./test queues
./test terminal
./test component
./test sim
./test mux
./test mux resize
./test mux agent
./test stress
./test extended
```

Core, protocol, presentation, composition, and Ghostty simulation failures print an exact replay
command. The worlds compare fragmented streams, generated resize/input/effect histories, composed
output replay, blocked-client recovery, and multi-pane incremental/full convergence. The mux world
runs the production `SessionMachine` against a simulated Runtime, injects spawn/resize/child faults,
and records joint operation × outcome × fault × state signatures plus transition pairs. Curated
seeds must cover every operation and required capacity, stale-generation, held-child, rollback, and
geometry bucket. The scripted reactor world executes the production reactor while controlling
readiness, request fragmentation, outbound `EAGAIN`, child wake ordering, and all monotonic time.
Generated mux histories are concrete, versioned operation/effect traces; replay does not invoke the
generator.
Seeds and traces can be selected directly:

```sh
LEMMA_SIM_SEED=0x1234 LEMMA_SIM_OPERATIONS=4096 ./test sim
LEMMA_MUX_SIM_SEED=0x1234 LEMMA_MUX_SIM_OPERATIONS=4096 ./test sim
LEMMA_MUX_SIM_TRACE=path/to/failure.min.trace ./test sim
```

Set `LEMMA_MUX_SIM_TRACE_OUT=path/to/trace` with a configured mux seed to retain the concrete trace
as it executes, including the operation that is in progress if a sanitizer aborts. Ordinary mux
failures write the complete trace and a bounded deterministic reduction under
`build/mux-sim-failures/`. After confirming a minimized failure is fixed, promote it with
`scripts/promote-mux-trace path/to/failure.min.trace regression-name 'one-line bug description'`.
Promotion replays the concrete operations without stale failure checkpoints, records the fixed
outcomes and discovery metadata atomically, and publishes the trace under
`tests/sim/corpus/mux/`. Every simulation run replays that permanent corpus, requires its bug
provenance, and validates its recorded command outcomes and state checkpoints.

Use `LEMMA_SIM_TRACE=1` with a non-mux replay command to stream completed operations before a
dependency abort that cannot return through the normal failure trace. Scheduled CI runs
`scripts/ci/mux-sim-campaign`; `LEMMA_MUX_CAMPAIGN_SEEDS` and
`LEMMA_MUX_CAMPAIGN_OPERATIONS` bound the local equivalent.

Parser fuzz targets are opt-in and retain checked-in seeds for the Lemma-owned attachment, host
input, and public JSON boundaries:

```sh
scripts/ci/configure sanitizers -DLEMMA_BUILD_TESTS=OFF -DLEMMA_BUILD_BENCHMARKS=OFF -DLEMMA_BUILD_FUZZERS=ON
cmake --build build/sanitizers --target lemma_attachment_decoder_fuzz lemma_host_input_parser_fuzz lemma_api_json_fuzz
./build/sanitizers/lemma_attachment_decoder_fuzz -runs=0 fuzz/corpus/attachment
./build/sanitizers/lemma_host_input_parser_fuzz -runs=0 fuzz/corpus/host-input
./build/sanitizers/lemma_api_json_fuzz -runs=0 fuzz/corpus/api
```

Linux links libFuzzer for mutation runs. The sanitizer lane replays the checked-in seed corpora,
runs each target for a bounded mutation interval with its protocol dictionary, then runs a longer
mux simulation with a seed generated outside the test process. The scheduled
`scripts/ci/fuzz-campaign` retains evolved corpora and minimized failure artifacts. After fixing a
genuine finding, use
`scripts/promote-fuzz-input TARGET INPUT CORPUS_NAME 'one-line bug description'`; promotion first
replays the input, then records its SHA-256, source, fixing revision, and regression provenance in
`fuzz/corpus/regressions.json`. Darwin replays the same corpora under ASan/UBSan because Xcode Clang
does not ship a libFuzzer runtime.

Tests should name one failure domain, synchronize on observable state with bounded deadlines, and
report enough state to diagnose a timeout. The mux harness uses structured Session/Pane inspection:
stable PaneId and TabId values own semantic identity, while PID is observed only for real process
lifetime assertions. Use native tests for pure invariants and Python only when the contract requires
real descriptors, PTYs, processes, or the daemon.

### Coding-agent skill benchmark

Run the local behavioral comparison interactively and choose the agent provider, model, and thinking
level at startup, or pass them explicitly:

```sh
just skill-bench
just skill-bench --provider xai --model grok-4.6 --thinking low
just skill-bench --provider xai --model grok-4.6 --repetitions 3 --case cold-failure
```

The benchmark gives each run an isolated workspace and Lemma runtime, randomizes paired baseline and
skill order, verifies terminal consequences externally, and writes raw traces plus JSON and Markdown
reports under `build/agent-skill-benchmark/`. Baseline runs cannot fetch the embedded skill through
`lemma skill`. Model calls may incur provider charges; this benchmark is local and is not a CI gate.

Pi is the built-in adapter. For another coding agent, pass an executable with `--adapter PATH`. The
benchmark invokes it as `PATH REQUEST.json` in the isolated workspace with the benchmark environment.
The request uses `lemma.agent-skill-benchmark-request/v1` and supplies the prompt, optional skill path,
provider, model, thinking level, and timeout. The executable must print one JSON object using
`lemma.agent-skill-benchmark-result/v1` with `returncode`, `final_text`, normalized `tool_calls` and
`tool_results` arrays, and `skill_loaded`; `usage` is optional. This adapter boundary keeps scenarios
and scoring independent of any one agent harness.

CTest remains the CI integration surface. Cheap tests run in parallel; process tests are serialized
where host contention changes the behavior under test. Stress, resource, and allocation work stays
outside the common edit loop.

## Performance and resources

Run short native benchmarks with:

```sh
./bench
./bench terminal
./bench layout
./bench protocol
./bench mux
```

Use the benchmark shell for the complete subject comparison, dedicated-host budgets, and memory
census:

```sh
nix develop .#benchmarks --command ./bench extended
nix develop .#benchmarks --command scripts/ci/regression-budgets
nix develop .#benchmarks --command scripts/ci/memory smoke
```

`benchmarks/workloads.json` is the sole scenario, suite, sample-policy, and terminal-lab authority.
Native C++ owns microbenchmark and process timing loops. Python may select adapters, launch isolated
subjects, verify completion, retain raw reports, and analyze them; it must not timestamp a measured
interaction. The headless report orders a direct-PTY baseline before Lemma, tmux, Zellij, and Herdr.
Execution randomizes workload blocks and subjects while direct controls bracket each supported block.

Process latency endpoints are deliberately distinct:

```text
key_to_pty          injected outer-PTY input to fixture receipt
key_to_outer_bytes  injected outer-PTY input to matching bytes emitted toward the host terminal
input_to_photon     external terminal-lab HID event to measured display change
```

Only the final endpoint is user-visible latency. A smoke report explicitly marks sparse p95 and p99
statistics invalid. Reports retain raw distributions, source and manifest identity, executable
SHA-256 values, and failures or unsupported capabilities as outcomes rather than samples. Cross-
subject validation permits only the subject/workload failure signatures reviewed in the manifest;
new adapter or competitor failures fail validation. Generated reports live under `build/` and are
not checked-in documentation.

A performance comparison must use the same build profile, fixture, work, completion condition, and
host. Distinguish CPU time, elapsed time, outer bytes, physical footprint, RSS, descriptors, and
wakeups. Shared-runner timing is diagnostic evidence, not a stable regression gate. Its scheduled
diagnostic sweep covers pane counts 1, 2, 4, 8, 16, 32, and the supported maximum to expose scaling
knees. Scheduled memory evidence also sweeps 1, 2, 4, 8, and 16 sessions and workspaces plus
1, 10, and 100 lifecycle churn cycles. Merge-blocking `scripts/ci/deterministic-budgets` enforces
zero steady-state allocations and reviewed exact bounds for routed bytes, composed frames, retained
queue depth, wire amplification, flushes, writer attempts, reactor polls, readiness events, outbound
sends, backpressure recovery, partial writes, and child wakeups.

For now, `box` is the approved performance host and the paired gate is invoked manually:

```sh
just performance-calibrate 3
just performance-gate main
```

`benchmarks/performance_hosts.json` pins its hardware identity, CPU policy, and `0-7` affinity.
Calibration captures the unchanged checkout repeatedly and fails if the reviewed ratio and absolute
noise floors do not contain the observed A/A spread; it never relaxes policy automatically. Linux
process CPU evidence uses nanosecond runtime from `/proc/PID/schedstat`, not scheduler-tick-rounded
`/proc/PID/stat` values. At the gate's 100 process samples, nearest-rank p99 endpoints remain explicit
diagnostics and absolute-target evidence rather than paired blockers because frame-cadence outliers
make their rank unstable.

The gate holds a host-wide lock, validates host state before and after capture, and builds the
baseline and current checkout with the current checkout's manifest, harness, and Nix toolchain. The
candidate-owned PTY fixture and native probe are built once and shared by both revisions so a harness
improvement cannot make an older baseline inexpressible. All evidence remains under
`build/performance/`. Paired regressions block independently of stricter absolute product targets, so
an existing target miss cannot authorize further degradation.

Host-dependent gates remain manual through `scripts/performance`; no GitHub workflow executes
candidate code on a persistent self-hosted runner. Any future automation must preserve the same host
lock, policy validation, CPU affinity, candidate-owned fixtures, and before/after state checks, while
adding a base-controlled review boundary or a disposable runner before untrusted code can execute.

The GUI-ready lab contract is `benchmarks/terminal_lab.schema.json`. Hardware-photodiode and
software-pixel captures remain separate methods and are ingested with `benchmarks/terminal_lab.py`;
every run identifies the Ghostty, Kitty, or WezTerm executable and configuration, display refresh
profile, sensor position, randomized input jitter, and direct or mux subject.

Measure before and after changes to input routing, PTY parsing or writes, rendering, composition,
layout projection, resize, scheduling, or client output. State which multiplier the change affects:
bytes, events, panes, frames, or clients.

## Python tooling

Python support and benchmark code uses uv, Ruff, and ty:

```sh
uv sync --locked
just python-check
```

Keep Python outside native microbenchmark loops. Python may launch workloads, verify completion,
collect samples, and report distributions.

## CI

`.github/workflows/quality.yml` contains merge-blocking formatting, build/test, clang-tidy, clangd,
Python, sanitizer, and workflow checks selected by changed paths. `.github/workflows/extended.yml`
runs the platform matrix plus scheduled simulation, fuzz, and benchmark sweeps.

The local equivalents live under `scripts/ci/`; `just ci-check` runs the merge-blocking set in a
safe sequence.

## Ghostty boundary

Ghostty owns terminal semantics and is pinned by:

- `third_party/ghostty-metadata/PIN.json`
- `flake.lock` and `flake.nix`
- the `third_party/ghostty` submodule for non-Nix builds

Only `lemma_terminal` may include Ghostty headers. Lemma-facing code uses Lemma-owned value types and
borrowed views with explicit lifetimes.

For an upgrade, update every pin together, inspect the upstream API and semantic changes, review
`third_party/ghostty-metadata/PATCHES.md`, then run terminal, mux, sanitizer, and relevant benchmark
or resource checks. A local patch must document why it exists and the condition for removing it.

## Documentation

Documentation describes current behavior, public contracts, and hard invariants. The binary help
and embedded JSON Schema own exact CLI and API grammar. Generated measurements stay under `build/`.
Design history, migration reports, plans, and roadmaps belong in version control history or the
issue tracker rather than the documentation set.
