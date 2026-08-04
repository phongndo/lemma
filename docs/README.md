# Lemma documentation

Start here:

- [`../TODO.md`](../TODO.md) — mutable current focus and capability backlog through 1.0.
- [`current-capabilities.md`](current-capabilities.md) — audited working, partial, scaffolded, and
  absent behavior.
- [`product-contract.md`](product-contract.md) — agreed 1.0 product and behavior decisions.
- [`roadmap.md`](roadmap.md) — outcome areas, priority guidance, release gates, and deferred scope.
- [`daily-driver-contract.md`](daily-driver-contract.md) — required mux behavior and its performance,
  robustness, compatibility, and adoption bar.
- [`core-mux-quality.md`](core-mux-quality.md) — batteries-included workflows, permanent robustness
  invariants, pane profiles, common completion semantics, and performance-claim policy.
- [`core-mux-phase1.md`](core-mux-phase1.md) — authoritative identity, command trace, launch context,
  lifecycle, scheduling bounds, and Phase 1 closeout evidence.
- [`architecture.md`](architecture.md) — authoritative daemon, thin client, server rendering,
  ownership, dependencies, hot-path rules, and extension boundary.
- [`single-pane-runtime.md`](single-pane-runtime.md) — currently implemented runtime ownership,
  tab/split behavior, and limitations.
- [`protocol.md`](protocol.md) — current wire format and versioned server-rendered evolution contract.
- [`performance.md`](performance.md) — benchmark methodology, current results, and production bounds.
- [`ci.md`](ci.md) — CI lanes, supported platforms, and local checks.

Planning uses only the mutable [`../TODO.md`](../TODO.md) execution backlog and
[`roadmap.md`](roadmap.md) outcome/release guidance. Historical checkpoint evidence is retained in
[`terminal-checkpoint-feasibility.md`](terminal-checkpoint-feasibility.md).

## Documentation contract

Architecture documents describe intended boundaries; component READMEs describe where code belongs.
If implementation and documentation disagree, identify whether implementation is transitional and
update code or documentation in the same change.

Architectural changes must state ownership and bounds, update affected contracts, and include
appropriate test or benchmark evidence. Durable feasibility findings belong in focused technical
documentation; execution priority belongs only in `TODO.md` and `roadmap.md`.
