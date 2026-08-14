# Engineering quality

Architectural changes require behavioral tests, adversarial tests, and measured resource evidence. A clean abstraction or a fast microbenchmark is not sufficient by itself.

## Change policy

Before a broad architectural refactor:

1. identify the behavior that must survive;
2. identify existing characterization tests or add them;
3. record relevant performance and resource baselines;
4. make the structural change;
5. run the same behavioral evidence;
6. compare the measurements; and
7. review whether ownership, dependency direction, and the system actually became simpler.

Apply this rule especially to:

- Session/Attachment separation;
- Pane/PaneRuntime separation;
- identity and store changes;
- command-model changes;
- reactor restructuring;
- terminal adapter changes;
- rendering architecture changes; and
- protocol changes.

Do not move large amounts of code and discover the contract afterward. Keep structural and behavioral changes separable where tests can distinguish them.

## Testing layers

### A. Pure semantic/Core tests

Mux semantics should be testable directly without:

- PTYs;
- Ghostty;
- sockets;
- real child processes; or
- a running reactor.

Exercise Session/Tab/Pane/Attachment state, IDs, ownership, command validation, layout, focus, zoom, copy policy, capacity, and typed outcomes as deterministic values and transitions. This testability is also an architectural constraint: if a semantic rule requires a descriptor or terminal emulator merely to construct it, the boundary is suspect.

### B. Terminal contract tests

Test `vt::Terminal` in isolation. Cover:

- VT input and parser boundaries;
- damage and complete projection;
- resize and reflow;
- modes and effective colors/styles;
- keyboard and application-input encoding;
- paste and mouse encoding;
- terminal responses and effects;
- scrollback, viewport, selection, search, and formatting;
- allocation and traversal bounds; and
- invalid, exhausted, and dependency-error behavior.

Tests use only Lemma-owned public types. Add a focused regression whenever a Ghostty API assumption causes an incident or upgrade change.

### C. Differential and convergence tests

For ANSI projection, prefer semantic convergence over brittle byte strings:

```text
input
  |
Ghostty A
  |
Lemma ANSI projection
  |
Ghostty B
  |
compare semantic visible state
```

Where feasible compare:

- cells and graphemes;
- style and effective colors;
- cursor position, shape, and visibility;
- primary/alternate screen identity; and
- important terminal and presentation modes.

Byte-for-byte goldens remain appropriate when bytes are the protocol contract, such as framing or a specific terminal response. They are not the default for equivalent ANSI presentations.

### D. Runtime and integration tests

Use actual PTYs and processes for:

- spawn and launch context;
- input/output and terminal-response ordering;
- resize;
- detach and reattach;
- child exit;
- client lifecycle and outer-terminal restoration; and
- daemon endpoint and protocol behavior.

Tests use isolated endpoints and environments, bounded deadlines, owned process groups, deterministic completion markers, and bounded diagnostics. They never touch a user's daemon.

### E. Adversarial and system tests

Explicitly test:

- slow and dead clients;
- PTY floods and blocked PTYs;
- resize storms;
- fragmented and partial writes;
- queue exhaustion;
- terminal-response overflow;
- malformed and oversized protocol input;
- stale generational IDs;
- memory, descriptor, process, and capacity exhaustion;
- extension crash, hang, and quota failure; and
- detach during activity.

The acceptable outcome is bounded rejection, disconnect, recovery, or fail-closed pane/session loss according to policy—never corrupted authority. Failed or incomplete work is not reported as a fast sample.

### F. Performance and resource evidence

Correctness and architecture tests come first. Benchmarks support them; they do not replace them.

Track end-to-end quantities that users and operators experience:

- key to PTY;
- key to visible output;
- PTY/high-scroll throughput;
- sparse render and full redraw cost;
- attach to visible state;
- resize-storm behavior;
- idle CPU and wakeups;
- RSS and memory per pane/attachment;
- steady-state allocations;
- emitted and transported bytes; and
- scaling at representative pane counts.

Measure one pane and populated configurations such as 4, 16, and the supported maximum. A benchmark that omits child processes, the client, or completion semantics must say so.

## Performance reasoning

Terminal performance paths are multiplicative:

- PTY parsing;
- terminal state queries;
- damage computation;
- rendering;
- pane composition;
- layout;
- resizing;
- client fanout;
- input encoding; and
- copy/search traversal.

Use this model:

```text
cost =
    work per event/byte/render
  x frequency
  x pane count
  x attachment/client count
```

A small operation is expensive when performed per cell, pane, frame, or client. Identify the multiplier before optimizing.

Prefer:

- retained buffers and caller-owned storage;
- spans, views, and narrow accessors;
- dense data and owner-local storage;
- incremental damage;
- bounded work and explicit quotas;
- fewer copies and allocations;
- fewer wakeups and syscalls; and
- fewer redundant Ghostty queries.

Avoid inside hot multiplicative loops:

- filesystem I/O or process-tree inspection;
- aggregate terminal snapshots when one scalar is needed;
- unnecessary formatting;
- temporary owning strings or vectors;
- duplicated terminal state;
- speculative caches; and
- virtual dispatch or pointer chasing added without evidence.

Do not sacrifice correctness or clarity for hypothetical micro-optimization. Measure first, retain raw distributions, state completion semantics, and label host/build/transport conditions. Relative claims require comparable adapters and identical work; there is no universal “fastest mux” claim.

Measured results and reproduction commands live in [`performance.md`](performance.md) and [`memory.md`](memory.md). Those documents contain evidence, not aspirations.

## Dependency qualification: libghostty-vt

Keep Ghostty's exact upstream commit, Zig version, build options, expected features, and optimization mapping pinned in `third_party/ghostty-metadata/PIN.json`. Configuration rejects a missing, mismatched, or dirty source tree.

For every Ghostty upgrade:

1. inspect upstream public API changes;
2. inspect terminal semantic changes relevant to Lemma;
3. review every adapter assumption;
4. review every local patch;
5. remove patches superseded upstream;
6. run terminal contract tests;
7. run differential/convergence tests;
8. run runtime integration and adversarial tests;
9. run relevant performance, allocation, and memory benchmarks; and
10. accept the new pin only after the evidence is reviewed.

Any local patch must be recorded in `third_party/ghostty-metadata/PATCHES.md` with:

- why it exists;
- the affected upstream version;
- an upstream issue, PR, or discussion when available;
- dedicated verification;
- an owner; and
- the exact removal condition.

A patch may not silently alter advertised child capabilities, allocator behavior, effects, results, modes, or private compatibility assumptions.

## Review evidence by change type

| Change | Minimum expected evidence |
| --- | --- |
| Pure semantic state/command | Core tests, invalid/stale/capacity cases |
| Terminal adapter | Contract tests; convergence when projection changes; upgrade review if applicable |
| Runtime resource ownership | Characterization plus real PTY/process and adversarial tests |
| Protocol | Golden codec, fragmentation/coalescing, malformed/oversized, version and backpressure tests |
| Rendering/layout | Semantic/component tests, full reconstruction, sparse/full measurements |
| Hot input/PTY/reactor path | Integration ordering/isolation plus latency/throughput/resource distributions |
| Extension boundary | Transaction, crash/hang/quota, backpressure, no-hot-path-wait tests |

## Available checks

Common local checks are:

```sh
just fmt-check
just lint
just lsp-check
just test
just check
```

`just ci-check` reproduces merge-blocking formatting, build/test, clang-tidy, clangd, sanitizer, workflow, and script checks in a safe sequence. Process tests are serialized where host-resource contention would invalidate them. Shared-runner benchmark timing is evidence for investigation, not a performance gate.

A completed change should leave the architecture easier to explain, not merely leave the test suite green.
