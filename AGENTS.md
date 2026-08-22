# Lemma

Read only the code, tests, and documentation relevant to the change. Public documentation defines
the supported contract; code defines current implementation reality.

Use:

- `docs/usage.md` for user behavior;
- `docs/api.md` for automation contracts;
- `docs/architecture.md` for ownership and data flow; and
- `docs/development.md` for design quality and verification.

## Design

- Treat performance as a product property, especially on per-byte, event, pane, frame, and client
  paths.
- Encode invariants in types, construction, and ownership so invalid states are hard to represent.
- Keep one authority per mutable fact; derive projections instead of duplicating state.
- Prefer bounded, direct designs with fewer owners, transitions, copies, and abstractions.
- Preserve ordering, lifetimes, failure behavior, and dependency-owned semantics.
- Measure when added hot-path complexity or a performance claim depends on the result.

Do not create plans, roadmaps, TODO documents, or historical reports unless requested.

## Verification

Use repository commands:

```sh
just build
just test
just fmt
just lint
just check
just ci-check
```

Run focused checks while developing and `just check` before completion. Do not ignore failing
verification or claim success without stating what was run.
