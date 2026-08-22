# Automation API

Lemma exposes one operation model and one observation model:

```text
Action  one bounded operation, query, input, capture, or wait
Proc    validated ordered composition of Actions
Event   immutable asynchronous observation
```

Shell automation should use `lemma action`, `lemma proc`, and `lemma events`. Dedicated clients may
use the same JSON contracts over the per-user Unix endpoint.

## Discover the installed contract

```sh
lemma api schema
lemma api schema --json
lemma action DOMAIN OP --help
```

The JSON form is the authoritative JSON Schema 2020-12 document for Actions, results, Procedures,
subscriptions, and Events. It is embedded in the binary and requires no running daemon.

The current operation catalog is:

```text
daemon   inspect
session  start list inspect rename kill
tab      new list inspect select move rename kill
pane     split list inspect focus swap resize zoom input capture wait kill
```

## Actions

An Action is one concrete `lemma.action/v1` request. CLI examples:

```sh
lemma action session start work --cwd "$PWD"
lemma action tab new --session work --title tests --focus preserve -- just test
lemma action pane split --session work --pane 0:1 --right --focus preserve
lemma action pane input --session work --pane 0:1 --paste 'just test' --key enter
lemma action pane capture --session work --pane 0:1 --source recent --lines 100
lemma action pane wait --session work --pane 0:1 --timeout 30s
```

Inside a Lemma pane, the CLI may infer omitted targets from `LEMMA_SESSION_ID`, `LEMMA_TAB_ID`, and
`LEMMA_PANE_ID`. This is a CLI convenience: the Action sent to the daemon always contains concrete
targets. Outside Lemma, provide the required Session and resource selectors.

Session names and one-based Tab positions are discovery conveniences. Persistent automation should
retain returned generational IDs. Tab and Pane IDs are Session-scoped.

`lemma action` prints one canonical `lemma.action-result/v1` JSON value. Successful statuses are
`applied` and `no_effect`. Other statuses include `stale`, `wrong_owner`, `conflict`, `capacity`,
`unavailable`, and `failed`. Results include the relevant stable IDs and, where applicable, the
current Session revision or terminal generation.

`pane.input` admits one ordered batch of text, opaque paste, and logical key events. `pane.capture`
reads a bounded visible, recent, or last-command projection. `pane.wait` is a finite Action; without
a condition it waits for child-process completion.

## Procedures

A Procedure is one `lemma.proc/v1` document containing at most 64 Actions:

```json
{
  "schema": "lemma.proc/v1",
  "on_error": "stop",
  "actions": [
    {"id":"work", "action":"session.start", "name":"work"},
    {"id":"tests", "action":"tab.new", "session":{"result":"work"},
     "focus":"preserve", "argv":["just","test"]},
    {"action":"pane.wait", "pane":{"result":"tests"}, "timeout_ms":120000},
    {"action":"session.kill", "session":{"result":"work"}}
  ]
}
```

```sh
lemma proc procedure.json
lemma proc - < procedure.json
```

Before executing anything, the daemon validates the complete envelope, every Action, all selectors,
bounds, IDs, and backward-only result references. References may select the `session`, `tab`, or
`pane` field of an earlier creation result.

Actions then execute in document order through the same executor used by `lemma action`. A Procedure
is not atomic: completed process and PTY effects are not rolled back. `on_error` is `stop` by default
or `continue`. The `lemma.proc-result/v1` response contains one ordinary Action result per executed
step and reports partial completion explicitly.

## Events

`lemma events` opens an observation stream:

```sh
lemma events --session work --pane 0:1
lemma events --session work --pane 0:1 --screen
```

A `lemma.events/v1` subscription selects one Session and optionally up to eight Panes. The stream
starts with an authoritative snapshot, then emits ordered state, process, terminal-invalidation,
optional screen, and closure Events. Screen data is opt-in, bounded current state rather than raw
PTY replay.

Observers cannot mutate state and are not terminal Attachments. A slow observer cannot block PTY
progress. Reconnecting creates a fresh snapshot; the daemon retains no Event replay log.

## Direct connections

The public integration endpoint is `/tmp/lemma-UID.sock`, owned by the current user with owner-only
permissions. Public JSON records are compact UTF-8 values terminated by LF. Each record is bounded
to 1 MiB, 4,096 JSON values, and 32 levels.

A CONTROL connection accepts an Action or Procedure and is lock-step: send one request, read its
complete result, then send the next. There is no pipelining or request-ID layer. An OBSERVE
connection begins with an Events subscription and only receives Events. Terminal attachment uses a
separate private framed protocol on the same endpoint.
