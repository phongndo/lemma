# Fiber documentation

Start here:

- [`../TODO.md`](../TODO.md) — ordered operational checklist from foundation hardening through 1.0.
- [`current-capabilities.md`](current-capabilities.md) — audited working, partial, scaffolded, and
  absent behavior plus the foundation gaps that determine the next implementation order.
- [`product-contract.md`](product-contract.md) — agreed foundation decisions and product questions
  that remain explicitly open.
- [`roadmap.md`](roadmap.md) — milestone order, release gates, adoption work, and explicitly deferred
  scope.
- [`daily-driver-contract.md`](daily-driver-contract.md) — required local mux behavior and the
  performance, robustness, compatibility, and user-adoption quality gate.
- [`architecture.md`](architecture.md) — target architecture, ownership, dependencies, hot-path
  rules, and extension boundary.
- [`single-pane-runtime.md`](single-pane-runtime.md) — current runtime ownership, window/split-pane
  behavior, limitations, and build-out plan.
- [`protocol.md`](protocol.md) — current local wire format, parser contract, and evolution rules.
- [`performance.md`](performance.md) — benchmark methodology and current results.
- [`ci.md`](ci.md) — CI lanes, supported platforms, and local checks.

Implementation plans:

- [`../.plan/next-phase.md`](../.plan/next-phase.md) — immediate foundation-hardening phase, ordered
  workstreams, commit sequence, gates, and review checkpoints.
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
