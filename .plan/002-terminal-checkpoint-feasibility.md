# Fiber terminal-checkpoint feasibility gate

## Status

Active next phase. This phase begins after the P0 closeout in
[`001-p0-local-mux-hardening.md`](001-p0-local-mux-hardening.md) and precedes authoritative-ID and
replication-protocol production work. It is a bounded feasibility and contract phase, not permission
to ship an incomplete checkpoint format.

The target architecture is defined in [`../docs/architecture.md`](../docs/architecture.md), protocol
direction in [`../docs/protocol.md`](../docs/protocol.md), and the contingent implementation phase in
[`003-replicated-terminal-foundation.md`](003-replicated-terminal-foundation.md).

## Decision to validate

Fiber intends to use one attached-client architecture:

```text
terminal checkpoint at sequence N
-> ready
-> ordered output/resize/reset/exit events after N
-> progressive scrollback
```

The daemon retains canonical `libghostty-vt` state. Smart clients import checkpoints and apply the
same subsequent terminal events. Local, SSH, reconnect, lag recovery, ANSI compatibility
presentation, and future native presentation all use this model.

The pinned `libghostty-vt` C API does not currently expose a complete portable terminal checkpoint
export/import contract. Internal page cloning or visible-screen formatting is not sufficient proof.
This phase must establish whether a correct bounded implementation can be added without serializing
private memory layouts or weakening Fiber's ownership and failure invariants.

## Outcome

The phase ends with one of two explicit results:

1. **Pass:** a reviewed Fiber-owned checkpoint model and prototype prove deterministic continuation,
   bounded resource use, authoritative side-effect policy, and acceptable size/time. P1 production
   work may proceed through `.plan/003`.
2. **Stop:** one or more required terminal states cannot be exported/imported correctly or within
   acceptable bounds. The roadmap returns to architecture review before IDs or protocol fields are
   coupled to an invalid design.

A partial visible-grid snapshot, a private Ghostty memory dump, or “works for common shells” is not a
pass.

## Scope

### Included

- Inventory all terminal state required to continue parsing at an arbitrary PTY read boundary.
- Specify authoritative versus replica terminal roles and side-effect behavior.
- Design a versioned, bounded Fiber-owned checkpoint value model.
- Determine the required `libghostty-vt` API additions and upstream strategy.
- Prototype export/import narrowly enough to run equivalence tests.
- Build a deterministic checkpoint-plus-tail conformance harness.
- Measure checkpoint size, export/import time, memory, and scrollback chunk behavior.
- Decide parser-version compatibility and mismatch policy.
- Update the architecture/protocol plan with evidence and archive this result.

### Excluded

- Production generalized protocol framing.
- Workspace, pane, or client store migration.
- Replacing the current `fiber-v8` endpoint.
- Production smart-client attachment.
- Native GPU rendering.
- Multiple attached clients or permissions.
- Broad SSH UX, agents, Lua callbacks, copy mode, or mouse features.
- Persistence across daemon death or reboot.

## Required checkpoint state inventory

The inventory must account for at least:

- primary and alternate screens, page lists, visible area, and retained scrollback identity;
- canonical columns, rows, cell pixel dimensions, reflow state, and pending resize semantics;
- active and saved cursor position, style, visibility, shape, and origin/wrap behavior;
- current rendition attributes, palette, default colors, protected cells, and tab stops;
- terminal modes, keyboard modes, mouse modes, focus/paste/synchronized-update state;
- character sets, UTF-8 decoder/parser continuation, and incomplete CSI/OSC/DCS/APC sequences;
- hyperlinks, semantic prompts/marks, titles, working-directory metadata, and bells/effects state;
- Kitty graphics/image state or an explicit unsupported/negotiated policy;
- queued terminal responses and a rule preventing replicas from writing them to the PTY;
- selection/search state only where terminal-owned continuation requires it; client-local interaction
  state is not authoritative checkpoint data; and
- version/features required to interpret every encoded field.

For each item, record:

- owner in the daemon and replica;
- whether it is needed before `ready`, may arrive as progressive history, or is deliberately omitted;
- maximum encoded size and element count;
- import behavior for unknown or unsupported values;
- whether it can generate side effects; and
- conformance observations available through the Fiber-owned adapter.

## Design constraints

### Fiber-owned format

The checkpoint schema is a Fiber protocol value. It may be implemented efficiently by Ghostty but
must not expose pointers, allocator identities, Zig/C struct layouts, or private enum numbers. Every
length and count is bounded and validated before client state mutation.

### Arbitrary event boundaries

PTY reads can end inside escape sequences and UTF-8 input. The design must either export/import the
parser continuation state or prove an alternative that never waits indefinitely and never loses or
reorders bytes. “Take checkpoints only when the parser looks idle” is not sufficient without a
bounded, exhaustive rule.

### Authoritative side effects

Only the daemon may produce PTY responses or apply authoritative clipboard, notification, process,
or security policy. Replica import and event application must suppress those outputs while retaining
all state needed for correct future rendering.

### Progressive history

The visible checkpoint should become presentable without requiring all configured scrollback. Recent
history may hydrate before older history, but chunks require stable ordering/range identity and may
not change the live event sequence. The phase need not implement production history transfer; it must
prove the state model can distinguish complete, partial, and missing history.

### Bounds

Export/import and comparison have hard deadlines and allocation quotas. No test stores an unbounded
session log. Corpus traces, output chunks, checkpoints, history ranges, and diagnostics retain bounded
heads/tails plus digests where full content is unnecessary.

## Workstream A — state and upstream API audit

- [ ] Enumerate checkpoint-relevant state from Fiber's adapter and pinned Ghostty terminal/parser
      implementation.
- [ ] Identify state already exposed by stable C values and state requiring new Ghostty APIs.
- [ ] Distinguish visible-ready state from progressive history and client-local presentation state.
- [ ] Document terminal responses/effects that replica writes must suppress.
- [ ] Decide whether the required API belongs upstream, in Fiber's pinned wrapper, or in a temporary
      prototype that must be upstreamed before release.
- [ ] Record graphics and unsupported-feature policy rather than silently dropping state.

### A exit gate

- [ ] Every continuation-relevant state category has an owner, wire policy, bound, and test
      observation.
- [ ] No proposed field serializes private Ghostty memory layout.
- [ ] Reviewers can explain how an attach inside an incomplete parser sequence remains correct.

## Workstream B — checkpoint value and API prototype

- [ ] Define a versioned checkpoint header and bounded section/table model without assigning final P1
      message kind numbers.
- [ ] Add or prototype explicit authoritative export and replica import operations behind
      `fiber_terminal`.
- [ ] Make import transactional: malformed, unsupported, over-capacity, or allocation-failed input
      leaves the previous replica unchanged or destroys a not-yet-published candidate.
- [ ] Suppress PTY responses and authoritative effects in replica role.
- [ ] Represent canonical dimensions and continuation sequence explicitly.
- [ ] Represent progressive-history ranges and completeness without embedding unbounded history in
      the ready checkpoint.
- [ ] Add deterministic checkpoint digest/observable-state helpers for tests only.

### B exit gate

- [ ] A new replica imports a checkpoint without Ghostty types crossing the adapter.
- [ ] Import rejects every oversized section before unbounded allocation.
- [ ] Replica application cannot expose bytes for the daemon PTY write queue.
- [ ] Format version and terminal-semantics mismatch are explicit results.

## Workstream C — deterministic equivalence harness

For a source terminal `A`, choose sequence boundary `N`, export/import replica `B`, then apply the same
events after `N` to both. Compare all Fiber-observable state and bounded deep terminal observations.

Required trace families:

- [ ] plain text, styled text, cursor movement, erase, insert/delete, and scroll regions;
- [ ] arbitrary one-byte and uneven PTY chunk boundaries;
- [ ] incomplete UTF-8, CSI, OSC, DCS, APC, and synchronized-update boundaries;
- [ ] primary/alternate-screen transitions and saved cursor/state;
- [ ] resize narrower/wider/taller/shorter with and without reflow and scrollback;
- [ ] grapheme clusters, combining characters, wide cells, tabs, and wrapped rows;
- [ ] title, hyperlink, bell, focus/paste, mouse, and keyboard mode changes;
- [ ] supported terminal queries with exactly one authoritative response stream;
- [ ] 10,000-row scrollback with visible-ready state plus recent-to-oldest progressive chunks;
- [ ] malformed, truncated, duplicate, out-of-order, unknown-version, and over-capacity checkpoints;
- [ ] allocation failure during export and import;
- [ ] randomized deterministic event traces with a recorded seed and bounded corpus.

### C exit gate

- [ ] Checkpoint plus tail matches uninterrupted parsing for every required trace and boundary.
- [ ] No replica produces a PTY response or duplicates an authoritative policy side effect.
- [ ] A failed import cannot corrupt a published replica.
- [ ] Failures print sequence, trace seed, checkpoint section, and bounded state diagnostics.

## Workstream D — performance and capacity evidence

Measure release builds for at least 80x24 and a supported large viewport with empty, ordinary shell,
editor-like alternate-screen, and maximum configured scrollback states.

- [ ] checkpoint encoded bytes and section breakdown;
- [ ] export and import p50/p95/p99 after warm-up;
- [ ] peak temporary and retained allocation;
- [ ] checkpoint digest/comparison overhead kept outside production hot paths;
- [ ] one-event tail application latency after import;
- [ ] recent-history and full-history chunk size/time;
- [ ] compressed versus uncompressed large checkpoint/history evidence, without compressing tiny
      interactive messages by assumption.

Initial results are feasibility evidence, not universal performance claims. Regression budgets are
set only after stable repetition.

### D exit gate

- [ ] Export/import complete under explicit deadlines and quotas for every supported case.
- [ ] Ready checkpoint size does not scale with all configured history unless evidence and contract
      deliberately choose that trade-off.
- [ ] No checkpoint operation blocks PTY progress in a production design; if the prototype is
      synchronous, `.plan/003` states the bounded scheduling mechanism required.

## Workstream E — decision and closeout

- [ ] Record the checkpoint schema and role semantics in `docs/protocol.md` at the level proven by the
      prototype.
- [ ] Record required upstream Ghostty changes, issue/patch references, and pinning policy.
- [ ] Update `docs/current-capabilities.md` without claiming production replication.
- [ ] Update `TODO.md` and `.plan/003` for evidence-driven implementation consequences.
- [ ] Run the required validation and archive this plan with a Pass or Stop decision.

## Required validation

- [ ] Focused terminal adapter and checkpoint tests in debug and release.
- [ ] Deterministic equivalence corpus under ASan/UBSan where supported.
- [ ] Release checkpoint benchmark with machine/build metadata.
- [ ] Existing 72 component and 12 process tests remain green.
- [ ] Existing server-rendered process benchmark remains a labeled migration baseline.
- [ ] `just check`
- [ ] `just ci-check`
- [ ] `git diff --check`
- [ ] Documentation link check.

## Commit sequence

1. **Inventory checkpoint state** — documentation and test-observation design only.
2. **Add test-only equivalence traces** — establish uninterrupted reference behavior.
3. **Prototype bounded checkpoint export/import** — adapter boundary and transactional import.
4. **Cover parser boundaries and side effects** — adversarial equivalence cases.
5. **Add history-range prototype** — visible-ready versus progressive history.
6. **Measure and decide** — release benchmarks, upstream plan, Pass/Stop archive.

Keep production protocol framing, ID-store migration, and attached-client cutover out of these commits.

## Review checkpoints

Stop for design review if:

- correctness requires serializing a private Ghostty struct or allocator-owned pointer;
- arbitrary parser continuation cannot be represented or bounded;
- a replica can emit PTY response bytes;
- ready checkpoint size necessarily includes unbounded/full history;
- import cannot be transactional under malformed or allocation-failed input;
- checkpoint generation requires an unbounded pause in PTY processing;
- conformance can compare only formatted visible ANSI rather than terminal semantics; or
- a final protocol encoding is proposed before the feasibility evidence exists.

## Completion gate

This phase passes only when Fiber can truthfully state:

> For every supported terminal trace and arbitrary bounded event boundary, a versioned bounded
> checkpoint imported into a fresh replica plus the ordered event tail produces the same observable
> terminal state as uninterrupted authoritative parsing; replica processing cannot generate PTY
> responses, and export/import resource costs are measured and bounded.

If that statement is not continuously testable, archive the phase as Stop and reopen the architecture
before executing `.plan/003`.
