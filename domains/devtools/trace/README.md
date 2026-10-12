# devtools.trace

Serves the host's trace (`Trace`, which the host provides) to clients, and its
web half (`./web`) shows it as the devtools' Trace panel.

| Channel                  | Kind   | What it answers                                                                             |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| `devtools.trace.spans`   | call   | The spans the host kept that match a query (attribute values, ended since), the newest 2000 |
| `devtools.trace.follow`  | stream | The spans that match as they end, in batches of up to 250ms                                 |
| `devtools.trace.changes` | call   | The composition's recent changes: what each started, stopped, and restarted, or why not     |

Their declarations are `TraceChannels` in [`@lemma/devtools`](../contract/src/index.ts).

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
