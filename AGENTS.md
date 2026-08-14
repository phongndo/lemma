# Guide

Inspect relevant code, tests, and docs before editing. Read only what the task needs.

Docs define intended contracts. Code defines current reality.

## Development

* Understand ownership, callers, and data flow before changing code.
* Make one cohesive change at a time.
* Prefer simple ownership and direct code over abstraction.
* Reuse existing concepts before adding new ones.
* Do not duplicate authoritative state or dependency-owned semantics.
* Preserve bounds, ordering, lifetimes, and failure behavior.
* Treat per-byte, event, pane, frame, or client work as performance-sensitive.
* Characterize broad refactors and measure performance-sensitive changes.
* Do not create plans, roadmaps, or TODO docs unless requested.

## Conversation

* Be concise and technical.
* Investigate before asking for context available in the repo.
* Surface important findings and meaningful tradeoffs.
* Recommend a solution when multiple options exist.
* After substantial work, summarize what changed and what was verified.

## Commands

Use repo commands:

```sh
just build
just test
just fmt
just lint
just check
just ci-check
```

Run focused checks while developing and `just check` before completion.

Run relevant integration/adversarial tests for runtime or boundary changes, and benchmarks before/after performance-sensitive changes.

Never ignore failing verification or claim success without stating what was verified.

## Completion

A change should be correct, tested, measured where needed, and no harder to reason about than before.
