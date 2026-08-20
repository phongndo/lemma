# Lemma procedures

`lemma proc FILE|-` executes one bounded JSON procedure and writes one compact JSON result document.
A procedure is a frontend envelope over ordinary Lemma actions; it is not a shell, task object, or
transaction. CLI session controls are top-level (`lemma start`, `lemma kill`), while JSON action
names remain resource-qualified (`session.start`, `session.kill`) as typed action discriminants.

## Envelope

```json
{
  "schema": "lemma.proc/v1",
  "on_error": "stop",
  "actions": []
}
```

- Input is at most 1 MiB, 4,096 JSON values, 32 levels deep, and 0–64 actions.
- The complete envelope, every action and selector, all prior-result references, and every field are
  validated before the first daemon request. Unknown fields, unknown actions, duplicate IDs,
  forward references, ambiguous selectors, and invalid bounds reject the document without side
  effects.
- `on_error` is `stop` (default) or `continue`. QA procedures that must run explicit cleanup after a
  runtime failure should use `continue`; the final process status remains nonzero when any action
  fails.
- Actions execute in document order and are non-atomic. Completed actions are never rolled back
  after a runtime failure.
- Creation IDs are unique 1–32 byte ASCII letters, digits, underscores, or hyphens.
- An action may reference only a typed `session`, `tab`, or `pane` returned by an earlier creation
  action.
- Launch argv is a JSON string array and is executed directly without shell interpretation.
- Waits default to 30 seconds, are bounded to 10 minutes, and use bounded client-side polling with backoff; the daemon retains no procedure waiter state.

## References and selectors

Creation actions return stable IDs:

```json
{"id":"work", "action":"session.start", "name":"work"}
{"id":"tests", "action":"tab.new", "session":{"result":"work"}}
{"action":"pane.capture", "pane":{"result":"tests", "field":"pane"}}
```

`field` may be omitted when the selector already determines the type. Explicit selectors use names,
positions, or generational IDs:

```json
{"session":{"name":"work"}}
{"tab":{"position":2}, "session":{"name":"work"}}
{"tab":{"id":"1:2"}, "session":{"name":"work"}}
{"pane":{"id":"1:3"}, "session":{"name":"work"}}
```

Titles are never selectors.

## Actions

### Queries

```json
{"action":"session.list"}
{"action":"session.inspect", "session":{"name":"work"}}
{"action":"tab.list", "session":{"name":"work"}}
{"action":"pane.list", "session":{"name":"work"}}
```

Query results contain bounded structured arrays rather than human listing text:

- `session.list` and `session.inspect` return `sessions` arrays with name, stable ID, attachment
  state, tab/pane counts, geometry, active tab, and focused pane.
- `tab.list` returns a `tabs` array with position, stable ID, active state, pane count, and focused
  pane.
- `pane.list` returns a `panes` array with stable pane/tab IDs, tab position, focus, geometry, and
  typed process state.

Titles are intentionally absent because they are presentation values, never selectors.

### Sessions

```json
{"action":"session.start", "id":"work", "name":"work", "cwd":"/repo",
 "hold":false, "argv":["nvim"]}
{"action":"session.rename", "session":{"result":"work"}, "name":"renamed"}
{"action":"session.kill", "session":{"result":"work"}}
```

`name`, `cwd`, `hold`, and `argv` are optional for `session.start`. An omitted name requests the
bounded numeric allocator.

### Tabs

```json
{"action":"tab.new", "id":"tests", "session":{"result":"work"},
 "title":"tests", "cwd":"/repo", "hold":true, "argv":["just","test"]}
{"action":"tab.select", "session":{"name":"work"}, "tab":{"position":2}}
{"action":"tab.move", "session":{"name":"work"}, "tab":{"position":2},
 "to_position":1}
{"action":"tab.rename", "session":{"name":"work"}, "tab":{"position":1},
 "title":"qa"}
{"action":"tab.kill", "tab":{"result":"tests"}}
```

Tab rename currently requires a one-based position. Select, move, and kill accept a position,
stable ID, or prior tab result.

### Panes

```json
{"action":"pane.split", "id":"server", "pane":{"result":"work"},
 "direction":"right", "hold":true, "argv":["npm","run","dev"]}
{"action":"pane.focus", "pane":{"result":"server"}}
{"action":"pane.swap", "pane":{"result":"server"}, "other":{"id":"0:1"},
 "session":{"name":"work"}}
{"action":"pane.resize", "pane":{"result":"server"}, "direction":"left", "amount":2}
{"action":"pane.zoom", "pane":{"result":"server"}, "enabled":true}
{"action":"pane.send", "pane":{"result":"server"}, "text":"status\r"}
{"action":"pane.wait", "pane":{"result":"server"}, "contains":"ready",
 "timeout_ms":30000}
{"action":"pane.wait", "pane":{"result":"server"}, "exit":true,
 "timeout_ms":120000}
{"action":"pane.wait", "pane":{"result":"server"}, "exit":{"code":0},
 "timeout_ms":120000}
{"action":"pane.wait", "pane":{"result":"server"}, "exit":{"signal":15},
 "timeout_ms":120000}
{"action":"pane.capture", "pane":{"result":"server"}, "lines":100}
{"action":"pane.kill", "pane":{"result":"server"}}
```

`pane.send` accepts literal text. It does not interpret a shell command or emulate mux prefix keys.
`"exit":true` accepts any process outcome. `{"code":N}` and `{"signal":N}` require that exact
typed outcome and return `unexpected_exit` on mismatch while preserving the actual process result.
An exit wait intended to retain status or output must target a pane created with `"hold":true`;
normal close-on-exit policy removes the target. `pane.capture` currently returns the canonical
visible screen as plain text; historical capture, semantic key/paste actions, and streaming
subscriptions are separate future contracts.

## Results

```json
{
  "schema": "lemma.results/v1",
  "ok": true,
  "results": [
    {
      "index": 0,
      "id": "tests",
      "action": "tab.new",
      "status": "applied",
      "session": "work",
      "tab": "1:1",
      "pane": "1:1"
    }
  ]
}
```

Statuses are `applied`, `no_effect`, `missing`, `conflict`, `capacity`, `unavailable`, `timeout`,
`unexpected_exit`, or `failed`. Both `applied` and `no_effect` are successful outcomes. Capture
results include `text`; exit waits include a process object whose state is `exited`, `signaled`, or
`exited_unknown` and whose value is the exit code or signal number.

Invalid or over-limit input produces a structured top-level error:

```json
{"schema":"lemma.results/v1","ok":false,
 "error":{"reason":"unknown_field","action_index":1,"field":"nmae"},"results":[]}
```

Reasons are `read_failed`, `invalid_json`, `invalid_document`, `unknown_field`, `invalid_schema`,
`invalid_actions`, `invalid_on_error`, `action_not_object`, `missing_or_invalid_field`,
`invalid_selector`, `invalid_or_duplicate_id`, `invalid_field`, `invalid_wait_condition`,
`unknown_action`, or `resource_failure`. An action index, field, or byte offset is included when
applicable. Validation errors occur before any action runs. A resource failure after execution
begins is conservatively marked `"partial":true` because an external effect may already have
committed.

A procedure exits 0 only when every executed action succeeds, 1 for an action/runtime failure, and 2
for an invalid or over-limit document.
