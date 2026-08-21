# Lemma procedures

`lemma proc FILE|-` executes one bounded `lemma.proc/v1` document. Dedicated CONTROL clients may
send the same document directly over the public integration API.

A Proc is not a second operation model:

```text
Action = one concrete Lemma operation
Proc   = whole-plan validation + sequencing + typed references over Actions
Event  = asynchronous observation
```

## Envelope

```json
{
  "schema": "lemma.proc/v1",
  "on_error": "stop",
  "actions": []
}
```

- Input is at most 1 MiB, 4,096 JSON values, 32 levels deep, and 0–64 Actions.
- The complete envelope, every Action, every selector, and every backward reference is validated
  before the first Action executes.
- Unknown fields, unknown Actions, duplicate IDs, forward references, type-invalid references, and
  invalid bounds reject the Proc without side effects.
- `on_error` is `stop` (default) or `continue`.
- Actions execute in document order and are non-atomic. Completed Actions are never rolled back.
- Proc contains Actions only. Waiting and streaming are observation concerns handled by Events.

## References

Creation Actions may bind a local ID:

```json
{"id":"work","action":"session.start","name":"work"}
{"id":"tests","action":"tab.new","session":{"result":"work"},"title":"tests"}
{"action":"pane.zoom","pane":{"result":"tests"},"enabled":true}
```

A reference may select a typed resource explicitly:

```json
{"result":"tests","field":"session"}
{"result":"tests","field":"tab"}
{"result":"tests","field":"pane"}
```

When the selector determines the required type, `field` may be omitted. References are resolved to
concrete stable IDs before each Action reaches the daemon-owned Action executor. Session rename
therefore does not require rewriting prior references.

Explicit selectors use names, one-based Tab positions, or generational IDs:

```json
{"session":{"name":"work"}}
{"session":{"id":"0:1"}}
{"session":{"id":"0:1"},"tab":{"position":2}}
{"session":{"id":"0:1"},"pane":{"id":"1:3"}}
```

Titles are never selectors.

## Actions

Proc accepts the same immediate Actions exposed by `lemma action` and `lemma.action/v1`:

- `session.list`, `session.inspect`, `session.start`, `session.rename`, `session.kill`
- `tab.list`, `tab.new`, `tab.select`, `tab.move`, `tab.rename`, `tab.kill`
- `pane.list`, `pane.split`, `pane.focus`, `pane.swap`, `pane.resize`, `pane.zoom`, `pane.send`,
  `pane.capture`, `pane.kill`

Launch `argv` is an exact JSON string array and is executed without shell interpretation. `hold`
retains an exited pane and its canonical terminal until a later Action kills it. A Proc
`session.start` that omits `cwd` and `environment` uses the account home directory and a bounded
snapshot of the daemon process environment; explicit values replace those defaults.

The complete action-specific fields, limits, selector unions, and result shapes are available from:

```sh
lemma api schema --json
```

## Results

```json
{
  "schema": "lemma.proc-result/v1",
  "ok": true,
  "results": [
    {
      "index": 0,
      "id": "tests",
      "result": {
        "schema": "lemma.action-result/v1",
        "action": "tab.new",
        "status": "applied",
        "session": {"id":"0:1","name":"work"},
        "tab": "1:1",
        "pane": "1:1"
      }
    }
  ]
}
```

Each entry contains the same canonical Action result returned by one-action CONTROL RPC. Successful
statuses are `applied` and `no_effect`. Other statuses include `stale`, `wrong_owner`, `conflict`,
`capacity`, `unavailable`, and `failed`. The daemon yields to other reactor work between Actions.
If retained results would exceed the 1 MiB record bound, it stops with `partial: true`, preserves all
previously encoded results, and reports the overflowing Action index and whether that Action had
already executed.

A document-validation failure returns exit status 2 and a structured `lemma.proc-result/v1` error.
An executed Action failure returns exit status 1. Complete success returns 0.
