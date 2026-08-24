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

Enter the development environment and build:

```sh
nix develop
just profile=debug build
```

Common commands:

```sh
just build             # configure and build the selected profile
just test              # fast native and real-mux tests
just fmt               # format C++, Nix, and Python
just fmt-check
just lint
just lsp-check
just python-check
just check             # build, formatting, analysis, tests, and Python checks
just ci-check          # all merge-blocking CI lanes
```

`profile` defaults to `release`; pass `profile=debug` when debugging. Run a focused check while
working and `just check` before completing a substantial change.

## Tests

The default suite separates deterministic component behavior from real process behavior:

| Tier | Responsibility |
| --- | --- |
| Native unit | Core values, commands, layout, protocol, queues, and input policy |
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
./test input
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
and checks all semantic and Core/Runtime ownership invariants after every operation. Generated mux
histories are concrete, versioned operation/effect traces; replay does not invoke the generator.
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
`scripts/promote-mux-trace path/to/failure.min.trace regression-name`. Promotion replays the
concrete operations without stale failure checkpoints, records the fixed outcomes atomically, and
publishes the trace under `tests/sim/corpus/mux/`. Every simulation run replays that permanent
corpus and validates its recorded command outcomes and state checkpoints.

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
runs each target for a bounded mutation interval, then runs a longer mux simulation with a seed
generated outside the test process. Darwin replays the same corpora under ASan/UBSan because Xcode
Clang does not ship a libFuzzer runtime.

Tests should name one failure domain, synchronize on observable state with bounded deadlines, and
report enough state to diagnose a timeout. The mux harness uses structured Session/Pane inspection:
stable PaneId and TabId values own semantic identity, while PID is observed only for real process
lifetime assertions. Use native tests for pure invariants and Python only when the contract requires
real descriptors, PTYs, processes, or the daemon.

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

Use the benchmark shell for comparisons and the memory census:

```sh
nix develop .#benchmarks --command ./bench extended
nix develop .#benchmarks --command scripts/ci/memory smoke
```

Reports are generated under `build/` and are not checked-in documentation.

A performance comparison must use the same build profile, fixture, work, completion condition, and
host. Retain raw distributions and distinguish CPU time, elapsed time, emitted bytes, memory,
descriptors, and wakeups. Shared-runner timing is diagnostic evidence, not a stable regression gate.

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
runs the platform matrix and scheduled benchmark smoke.

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
