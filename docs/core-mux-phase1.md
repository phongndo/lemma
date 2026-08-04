# Phase 1 — authoritative mux kernel closeout

## Status

The Phase 1 foundation is implemented. The production reactor now resolves hierarchical stable IDs,
records typed command outcomes, captures bounded session launch context, applies aggregate fairness
budgets, and provides predictable default/help/version/shutdown lifecycle behavior. The existing mux
vertical slice remains operational throughout the change.

This closeout is narrower than the versioned client protocol in Phase 2 and the richer layout/input
work in later phases. Current user behavior remains audited in
[`current-capabilities.md`](current-capabilities.md).

## Authoritative identity

- Sessions live in `BoundedGenerationalStore<Session, SessionId, 64>`.
- Tabs retain owner-local generational slots identified by `SessionId + TabId`.
- Panes retain owner-local generational slots identified by `SessionId + TabId + PaneId`.
- Each successful attachment receives a new `ClientId` generation owned by its session.
- Focus, previous-pane state, and layout leaves retain `PaneId`, never a reusable numeric pane slot.
- Pending attach reservations retain `SessionId`, not a pointer across reactor turns.
- Store erase/reuse rejects stale generations, including deterministic 4,096-operation churn tests.

IDs use `slot:generation` in current human-readable listings. The private control protocol remains
name-oriented until its Phase 2 replacement; listing an ID is not yet a promise of stable public wire
encoding.

## Semantic command boundary

`CommandDispatcher` validates command kind, origin, argument bounds, and the complete explicit target
hierarchy before invoking authoritative mutation. Runtime resolution distinguishes malformed,
stale, wrong-owner, capacity, unavailable, no-effect, failed, and applied outcomes.

Every session retains the newest 256 resolved `CommandTraceEntry` values. Each entry has a monotonic
sequence, the complete command/target, and its result. The observer records validation failures as
results as well as successful mutations. This is bounded deterministic evidence, not an event queue
or persistence mechanism.

Split mutations reserve all available slots and create the new PTY-backed pane before committing the
layout tree. Splitting a zoomed pane derives its tiled geometry without first mutating zoom, so a
rejected split has no partial focus/zoom side effect. A platform PTY-resize failure still retires the
owning session rather than pretending a partially applied external resize rolled back.

## Process and application lifecycle

The unconfigured binary now provides:

- plain `lemma` to create or enter `default`;
- dedicated `help`/`--help` and `version`/`--version`;
- status 2 plus a diagnostic for invalid commands and arity;
- explicit `shutdown`, distinct from `kill-all`, which flushes its response before daemon unwind; and
- nonzero attached-client termination plus terminal restoration and a diagnostic when the session
  ends or transport is lost unexpectedly.

Production session creation carries an immutable bounded launch snapshot:

- absolute cwd: 1–4,096 bytes;
- environment block: at most 65,535 bytes and 256 validated NUL-terminated entries; and
- Lemma-owned `TERM`, `COLORTERM`, and `TERM_PROGRAM` overrides at child launch.

The first pane and later tabs/splits inherit that session snapshot. Focused-process cwd discovery and
exact pane exit status/reason presentation remain later lifecycle refinements; unexpected termination
is currently precise at the client success/failure level but not at the child wait-status level.

## Scheduling and bounds

PTY readiness is serviced before client mutation using a rotating cursor and a 256 KiB aggregate
read budget per reactor turn. Each pane remains locally bounded, and the cursor advances when the
aggregate budget is exhausted. Ordered PTY writes retain their existing rotating 1 MiB aggregate
turn budget. Client/control/extension stages remain bounded and extension work remains last.

New fixed bounds introduced by this phase are:

| Resource | Bound |
| --- | ---: |
| Session store | 64 |
| Per-session command trace | 256 entries |
| Launch cwd | 4,096 bytes |
| Launch environment | 65,535 bytes / 256 entries |
| Aggregate PTY reads per turn | 256 KiB |

## Evidence

The closeout is covered by component and real-process tests for:

- generational capacity, erase/reuse, and deterministic stale-ID churn;
- command target hierarchy and observer results;
- bounded context-size encoding;
- malformed cwd/environment setup rejection without disturbing a healthy session;
- invoking cwd and environment inheritance in the real shell PTY;
- default invocation, help, version, invalid-command statuses, and daemon shutdown;
- unexpected last-shell exit diagnostics, nonzero status, and terminal restoration; and
- all existing topology, attach/reconnect, slow-client, blocked-PTY, ordering, and fairness cases.

Performance changes remain subject to [`core-mux-quality.md`](core-mux-quality.md) and the checked-in
release benchmark smoke.
