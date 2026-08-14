# Agent guidance

Lemma's documentation defines architectural constraints and product truth. It is not an implementation plan.

## Before substantive work

- Read [`docs/architecture.md`](docs/architecture.md).
- Read [`docs/terminal.md`](docs/terminal.md) for terminal, input, copy/search, or rendering work.
- Read [`docs/quality.md`](docs/quality.md).
- Read [`docs/product-contract.md`](docs/product-contract.md) when behavior or product boundaries matter.
- Read [`docs/current-capabilities.md`](docs/current-capabilities.md) when implementation status matters.
- Inspect the current code and tests before proposing or editing anything.

## Development rules

- Reason from current code, not a roadmap.
- Architecture documents are constraints, not implementation recipes.
- Investigate before editing; prefer one cohesive change at a time.
- Identify the single owner of every new mutable value.
- Keep semantic state separate from descriptors, processes, queues, and other runtime resources.
- Route semantic mutations through typed commands.
- Prefer deleting duplicated responsibility over adding abstraction.
- Do not duplicate Ghostty terminal semantics or create another canonical terminal grid.
- Keep Ghostty headers, handles, enums, allocators, and layouts behind `terminal/`.
- Do not add terminal backend interfaces or runtime polymorphism without a demonstrated requirement.
- Identify whether changed work lies on a multiplicative path.
- Characterize behavior before broad refactors and benchmark performance-sensitive changes.
- Preserve explicit bounds and failure behavior at every external boundary.
- Avoid speculative architecture and speculative caches.
- After implementation, ask whether ownership, dependency direction, and the system as a whole became easier to explain.

`plan.md`, TODO lists, old phase documents, roadmaps, and historical task descriptions are not architectural authority. They have been removed; do not recreate them unless the user explicitly asks.
