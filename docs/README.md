# Fiber documentation

Start here:

- [`product-contract.md`](product-contract.md) — agreed foundation decisions and product questions
  that remain explicitly open.
- [`architecture.md`](architecture.md) — target architecture, ownership, dependencies, hot-path
  rules, and extension boundary.
- [`single-pane-runtime.md`](single-pane-runtime.md) — current runtime ownership, window/split-pane
  behavior, limitations, and build-out plan.
- [`protocol.md`](protocol.md) — current local wire format, parser contract, and evolution rules.
- [`performance.md`](performance.md) — benchmark methodology and current results.
- [`ci.md`](ci.md) — CI lanes, supported platforms, and local checks.

## Documentation contract

Architecture documents describe intended boundaries; component READMEs under `src/` describe where
code belongs. If implementation and documentation disagree, do not silently assume either is
correct: identify whether the implementation is transitional, then update code or documentation in
the same change.

Humans and coding agents should read `architecture.md` and the README for every component they
modify. Architectural changes must update these documents, state ownership and bounds explicitly,
and include an appropriate test or benchmark plan.
