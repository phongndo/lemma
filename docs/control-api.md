# Lemma Control API

Lemma exposes one operation model and one observation model:

```text
Action = one Lemma operation
Proc   = bounded, validated sequence of Actions
Event  = observation
```

```text
                         Lemma daemon
                        /            \
                 CONTROL              OBSERVE
                    |                    |
              Action / Proc             Events
```

The production endpoint is `/tmp/lemma-UID.sock`, owned by the user and created with owner-only
permissions. It is the public integration API for dedicated CONTROL and OBSERVE clients.
Terminal attachment uses the same endpoint but remains a separate framed terminal transport rather
than another control model. Coding agents should use `lemma action`, `lemma proc`, and
`lemma events` (`lemma skill`) rather than opening this socket.

## Public CLI

```text
lemma
├── new [NAME] ...
├── start [NAME] ...
├── attach [NAME]
├── list (alias: ls)
├── inspect NAME
├── rename OLD NEW
├── kill NAME
├── action ...
├── proc FILE|-
├── events ...
├── api schema [--json]
├── skill
├── version
└── help
```

Common Session lifecycle commands remain noun-free at the top level. The complete Session, Tab,
and Pane operation set lives uniformly under `lemma action`; its Session domain remains available
as an advanced structured form, not the ordinary human spelling. The awkward `lemma tab ...` and
`lemma pane ...` command families are not public grammar. Keybindings and mouse remain the primary
interactive mux interface.

Examples:

```sh
lemma start work
lemma list  # `lemma ls` is equivalent
lemma inspect work
lemma rename work project
lemma kill project

lemma action tab new --session work --title tests
lemma action pane split --session work --pane 0:1 --right
lemma action pane capture --session work --pane 0:1
lemma action pane split --help
```

`lemma action DOMAIN OP --help` prints the exact installed CLI grammar for each Action without
contacting the daemon. Use the full JSON Schema only when exact Action or Proc document shapes are
needed. Launches keep running without `--hold`; that option retains a pane only after its process
exits so final terminal output remains observable.

Inside a Lemma pane, the CLI reads `LEMMA_SESSION_ID`, `LEMMA_TAB_ID`, and `LEMMA_PANE_ID` from the
child environment. Omitted targets resolve from those stable IDs before transmission. Explicit
`--session`, `--tab`, and `--pane` selectors operate on other resources. Context inference is only a
CLI convenience; the Action crossing CONTROL is concrete and deterministic.

`lemma action` prints the canonical JSON Action result. `lemma proc` prints the canonical Proc
result. `pane.list` includes each Pane's zero-based `column` and `row` in the Session content grid,
as well as its `columns` and `rows`, so layout order remains observable after swaps. Pane resize
directions move the nearest matching divider rather than promising to grow the target: right/down
grows the divider's left/top side, while left/up grows its right/bottom side. These CLI commands are
the shell and coding-agent interface. Dedicated integrations may use CONTROL and OBSERVE directly.

## CONTROL connection

A connection whose first byte is `{` is a public JSON connection. Every record is one compact UTF-8
JSON value terminated by LF and bounded to 1 MiB, 4,096 JSON values, and 32 levels.

CONTROL accepts either:

- one concrete `lemma.action/v1` Action; or
- one complete `lemma.proc/v1` Procedure.

The connection is lock-step: send one record, consume its complete result, then send the next.
There is no pipelining, request-ID layer, or multiplexed Event traffic. An idle CONTROL connection
may remain open for a persistent agent; once a client starts an incomplete record, it must continue
making progress or the daemon closes it after the bounded setup timeout.

Example Action:

```json
{"schema":"lemma.action/v1","action":"pane.capture","session":{"id":"0:1"},"pane":{"id":"1:3"},"lines":100}
```

Example result:

```json
{"schema":"lemma.action-result/v1","action":"pane.capture","status":"applied","session":{"id":"0:1","name":"work"},"tab":"1:1","pane":"1:3","text":"..."}
```

Names and one-based Tab positions are convenience selectors. Persistent clients should retain
returned generational IDs. Tab and Pane IDs are Session-scoped, so their parent Session selector is
always explicit in a concrete Action.

The `lemma start`, `lemma new`, and `lemma action session start` frontends materialize the invoking
working directory and environment before sending `session.start`. A direct Action or Proc that
omits `cwd` and `environment` uses the account home directory and a bounded snapshot of the daemon
process environment. Thus every created Session stores an absolute launch directory and an
environment snapshot rather than inheriting an unstored daemon cwd.

## Proc

A Proc adds only:

1. whole-document validation before side effects;
2. ordered bounded execution; and
3. backward-only typed references to prior creation results.

References are resolved to concrete IDs before each Action reaches the same daemon-owned executor.
Proc contains Actions only; waiting and streaming remain Event concerns. See
[`procedures.md`](procedures.md).

## OBSERVE connection

The first record is a `lemma.events/v1` subscription:

```json
{"schema":"lemma.events/v1","session":{"id":"0:1"},"pane":{"id":"1:3"},"screen":true}
```

The daemon returns sequence zero as an initial snapshot, followed by ordered `state.changed`,
`pane.process`, `pane.screen`, and `pane.closed` records. `pane.screen` is opt-in and contains a
coalesced current plain-text projection, not raw or lossless PTY replay.

Observers are Runtime-owned replaceable resources, not Attachments. They cannot mutate state, never
block PTY progress, and retain no replay log. Reconnection begins with a new authoritative snapshot.

## Schema

```sh
lemma api schema
lemma api schema --json
```

The default form prints a concise human catalog. `--json` prints the exact embedded JSON Schema
2020-12 compound document for Actions, Action results, Procedures, Proc results, subscriptions, and
Events without contacting the daemon.

## Ownership

```text
CLI action parser -----+
Proc resolver ---------+--> concrete Action --> one daemon executor --> Core / Runtime
CONTROL client --------+

Core / Runtime post-state --> immutable Event --> OBSERVE clients
```

JSON grammar, CLI context, and Proc references do not become Core state. Runtime owns public
descriptors, bounded decoders, retained output, deadlines, subscriptions, and backpressure.
