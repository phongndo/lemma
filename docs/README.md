# Fiber documentation

Start here:

- [`../TODO.md`](../TODO.md) — ordered operational checklist from foundation hardening through 1.0.
- [`current-capabilities.md`](current-capabilities.md) — audited working, partial, scaffolded, and
  absent behavior plus the foundation gaps that determine the next implementation order.
- [`product-contract.md`](product-contract.md) — agreed foundation decisions, including the single
  checkpointed terminal-replication client architecture, and product questions still open.
- [`roadmap.md`](roadmap.md) — milestone order, release gates, adoption work, and explicitly deferred
  scope.
- [`daily-driver-contract.md`](daily-driver-contract.md) — required local mux behavior and the
  performance, robustness, compatibility, and user-adoption quality gate.
- [`architecture.md`](architecture.md) — authoritative-daemon/smart-client target architecture,
  checkpoint/event synchronization, ownership, dependencies, hot-path rules, and extension boundary.
- [`single-pane-runtime.md`](single-pane-runtime.md) — current runtime ownership, window/split-pane
  behavior, limitations, and build-out plan.
- [`protocol.md`](protocol.md) — current local wire format, parser contract, and evolution rules.
- [`performance.md`](performance.md) — benchmark methodology and current results.
- [`ci.md`](ci.md) — CI lanes, supported platforms, and local checks.

Implementation plans:

- [`../.plan/001-p0-local-mux-hardening.md`](../.plan/001-p0-local-mux-hardening.md) — completed P0
  workstreams, evidence, gates, and remaining hosted validation.
- [`../.plan/002-terminal-checkpoint-feasibility.md`](../.plan/002-terminal-checkpoint-feasibility.md)
  — active checkpoint state inventory, export/import prototype, equivalence, side-effect, and
  performance gate.
- [`../.plan/003-replicated-terminal-foundation.md`](../.plan/003-replicated-terminal-foundation.md)
  — contingent authoritative-ID, checkpoint/event protocol, smart-client, resynchronization,
  client-side composition, SSH proof, and cutover plan.
- [`plans/process-level-pty-harness.md`](plans/process-level-pty-harness.md) — isolated daemon/client
  integration harness design, scenario set, CI integration, and acceptance criteria.

## Documentation contract

Architecture documents describe intended boundaries; component READMEs under `src/` describe where
code belongs. If implementation and documentation disagree, do not silently assume either is
correct: identify whether the implementation is transitional, then update code or documentation in
the same change.

Humans and coding agents should read `architecture.md` and the README for every component they
modify. Architectural changes must update these documents, state ownership and bounds explicitly,
and include an appropriate test or benchmark plan.
