# Testing redesign measurements

This records the first implemented migration slice described in [`testing.md`](testing.md). It does not count the retained C++ E2E characterization lane as migrated; that lane remains explicit `extended` coverage until its KEEP behavior has focused Python replacements.

Measurements use the same Apple M4 Max host and debug/release methodology as the old baseline. Raw logs are under `build/test-architecture-baseline/`.

## Old and new common-loop results

```text
OLD

clean test build:       22.99 s
incremental test build:  0.89 s
unit runtime:            22.50 s
mux/E2E runtime:         20.56 s
full runtime:            38.14 s

NEW

clean all-tier test build: 22.37 s
clean common test build:   21.99 s
incremental domain build:   0.77 s
pure unit runtime:          0.01 s
terminal boundary runtime:  0.11 s
component integration:      0.09 s
Python mux runtime:          5.14 s
full common CTest runtime:   5.60–5.71 s
```

Clean builds use a fresh build tree, existing Conan packages, warm ccache, and test targets only. The all-tier measurement includes legacy, stress, resource, and allocation binaries; the common measurement excludes those explicit tiers. The small clean-build change is expected: production libraries and the per-build-tree Ghostty archive dominate, not GoogleTest. Incremental measurements force one changed layout test translation unit and relink only its domain binary.

The native common correctness work fell from 22.50 seconds to about 0.21 seconds. The full common suite fell from 38.14 seconds to about 5.7 seconds while adding eight real Python mux scenarios. Expensive evidence remains available rather than being hidden:

| Explicit tier | Runtime |
| --- | ---: |
| Native generated/exhaustive state-machine stress | 1.34 s |
| Real mux state-machine stress, 64 deterministic operations | 3.78 s |
| Terminal scrollback/compression resource tests | 22.04 s |
| Retained 43-case C++ E2E characterization | 20.45 s |
| Steady-state allocation audit | 8.01 s |
| Complete serialized `extended` tier | 56.03 s |

## GoogleTest build evidence

The old monolithic GoogleTest binary compiled and linked in 1.43 seconds with production libraries built and ccache disabled. New domain builds measured:

```text
unit domain compile + link:              1.07 s
terminal-boundary domain compile + link: 1.01 s
```

The domains were measured sequentially, so their sum is not a clean-build critical path. The result confirms that replacing GoogleTest would not materially improve developer feedback. Domain separation is valuable for selective rebuilding and execution; framework removal is not.

## Audit and migration counts

The pre-change source audit covered 253 source-defined native cases/programs:

```text
KEEP:     206
MOVE:      18
REWRITE:   13
DELETE:    16
```

Implemented in this slice:

- 17 old native cases were removed, including four greeting/dependency smoke tests, the positional-options implementation-detail test, the getter/assignment Session construction test, duplicate/fake parity cases, and the speculative disabled graphics case;
- the `GhosttyParity*` dumping ground was removed; 11 unique contracts now have terminal render, synchronized-output, or resize-transaction ownership;
- three terminal resource cases, two exhaustive/generated cases, dependency integrity, allocation evidence, extension/platform process contracts, and the legacy process characterization have explicit non-unit tiers;
- five Python PTY/screen support tests moved out of benchmark ownership into shared test support;
- one protocol bound test was rewritten around representation boundaries rather than one arbitrary constant;
- the sleep-based blocked-output branch of a broad signal test was removed after it failed to establish the claimed blocked state deterministically; normal signal restoration remains, while actual blocked-client behavior stays in the explicit pressure workloads;
- eight focused Python mux scenarios were added;
- two deterministic state machines were added: one pure layout/identity machine and one real daemon/client/PTY/process machine.

The retained legacy characterization suite means the process-test migration is intentionally incomplete. It is labeled `extended`; it is not silently counted as a new Python mux scenario.

## New behavioral coverage

### Mux scenarios

1. split children have independent PIDs and closing one leaves the sibling responsive;
2. pane swap preserves both child owners and responsiveness;
3. output produced while genuinely detached appears from canonical state after real reattach;
4. destroying a detached session reclaims its child;
5. nested outer resize reaches all three real child PTYs with exact `stty size` geometry;
6. child DECCKM state changes the bytes delivered for a typed Up key through Ghostty encoding;
7. styled child output remains composed with an unaffected neighboring pane;
8. synchronized output holds one pane while a sibling progresses, then releases the held presentation.

### Lemma/libghostty-vt integration scenarios

The DECCKM, styled-composition, synchronized-output, and nested-resize scenarios exercise real child → PTY → daemon → Ghostty → composition → client consequences. They complement, rather than duplicate, adapter unit contracts.

### Stress invariants

The pure deterministic machine checks after every operation:

- valid topology and exact pane count;
- positive, bounded pane rectangles;
- pairwise non-overlap;
- stale generational IDs never reappear in topology or projection;
- reproducible seed and operation log on failure.

The real mux machine checks after every applicable operation:

- modeled pane count equals daemon topology;
- focused PID belongs to a live pane;
- all modeled pane children remain alive;
- closed children terminate;
- detached panes remain alive;
- reattach restores a live client baseline;
- resized geometry is committed before progress continues;
- the focused child remains responsive;
- final session teardown reclaims every observed child.

## Benchmark changes

```text
benchmarks removed: 3
  benchmark_greeting
  benchmark_extension_registration_codec
  benchmark_terminal_render_updates

benchmarks added: 0
benchmarks rewritten: 3
  stable small terminal writes
  stable alternate-screen large-write throughput
  stable production full redraw
```

The native benchmark TU plus link fell from 0.72 to 0.68 seconds with production libraries built and ccache disabled. The release benchmark developer smoke is about 5.25 seconds with three samples per case. The default one-repetition run fell from 32.99 seconds with a failure to 29.34 seconds completed. The formerly failing default run now completes; the evolving full-frame fixture was replaced by a stable populated production `render_ansi(..., true)` workload. Debug smoke no longer aborts during skipped PTY benchmark teardown.

Python remains outside every measured native hot loop. Real mux benchmark orchestration continues to require exact completion before retaining samples.
