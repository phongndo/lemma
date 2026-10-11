# devtools.trace

Serves the host's trace (`Trace`, which the host provides) to clients, and its
web half (`./web`) shows it as the devtools' Trace panel.

| Channel                  | Kind   | What it answers                                                                             |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| `devtools.trace.spans`   | call   | The spans the host kept that match a query (attribute values, ended since), the newest 2000 |
| `devtools.trace.follow`  | stream | The spans that match as they end, in batches of up to 250ms                                 |
| `devtools.trace.changes` | call   | The composition's recent changes: what each started, stopped, and restarted, or why not     |

Their declarations are `TraceChannels` in [`@lemma/devtools`](../contract/src/index.ts).

## The Trace panel

Its web half adds the devtools' Trace panel, for the host's trace or the
page's (`PageTrace`):

- **Spans**: the traces (root spans) that hold a span the filter picks, newest
  first; one opens to a waterfall of the spans under it, each bar where it ran
  in the trace. A span selected shows its attributes, and leads to its
  plugin, its thread's trajectory, and the filter for its turn or tool call.
- **Plugins**: each plugin's spans that match: how many, their own and total
  time, p95, the slowest, and how many failed. A row narrows to the plugin.
- **Changes**: the composition's changes, newest first.
- **Faults**: each plugin's recent faults, and the spans that failed.

The filter is words, each narrowing what shows: `plugin:tools` (a plugin, or a
domain's), `session:`, `turn:` (an id, or the Nth turn the trace kept),
`step:` (an id, or an index in its turn), `tool:` (a tool's name or a call's
id), `hook:`, `name:`, `status:error`, `slow:>5ms`, any of them negated with
`-`, and plain words matched in names and values. Other plugins lead here with
`devtools.show(TRACE_PANEL, filter)` (`trace:page` picks the page's trace): the
Plugins panel's **Spans**, and a trajectory record's **Show in trace**, which
this plugin adds to `TrajectoryActions`.

## Rationale

- **The host keeps, a plugin serves.** Only the host can trace its whole
  program, so the collector is its runtime (`Trace`); what leaves the host,
  and to whom, is this plugin's, so turning it off sends nothing anywhere.
- **Secrets stay.** The host's own HTTP server records what a request
  carried (its headers, its URL), which can hold the token a client
  connected with. What this plugin serves hides any attribute named for a
  secret (`authorization`, `cookie`, `token`, …, not a count of tokens) and a
  secret query parameter, in a URL or a query on its own. A query is matched
  against what is served, so it cannot confirm a guessed secret.
- **In memory, bounded.** The host keeps the last few thousand spans: enough
  to see what a turn or a reload did while it is fresh, and nothing to clean
  up. What has to outlast it is credited in the session's log instead
  ([sessions](../../sessions/README.md)).
