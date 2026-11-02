# threads.trajectory

Shows the open thread as the requests and tool runs behind it, as Chrome
DevTools' Network panel shows a page's: a filter toolbar, an overview of the
thread's time, a sortable table with a waterfall column, a details panel in
tabs, and a status bar with the totals of the rows shown. A model call's or tool
run's Pipeline tab says what shaped it, plugin by plugin. It adds the
`trajectory` view to `Views` (order 10, without the composer). It draws what
plugins add to `TrajectoryActions`, and each tool's `ToolViews` body
([`@lemma/threads`](../contract/src/threads.ts)).

Everything is projected from `Threads.branch` with `trajectory` and `ledger`
([`@lemma/sessions`](../../sessions/contract/src/ledger.ts)). On the Plugins
page it adds a `PluginsFacts` line (the open thread's latest request in tokens,
and how many of its parts changed since the one before). It adds a **Cost** tab
to `PluginTabs` ([`@lemma/settings`](../../settings/contract/src/index.ts)) for
each plugin that put something in it (`pluginShares`). No config.

## Behavior

- **The filter** takes `parseLedgerFilter`'s terms (`is:error`, `tool:bash`,
  `turn:2`, …).
- **The time axis** is to scale within a turn. The idle time between turns
  shrinks to a sliver, so one long pause does not squash every turn.
- **The pipeline** comes from the log. For a model call it shows the
  `AgentRequestHook` handlers (each one's own time and what it changed), the
  retries, and why the turn went on or stopped (`AgentContinueHook`). For a tool
  run it shows the `ToolExecuteHook` handlers, the guards' decisions, and where
  the registry cut the result.
- **Copy exact request**, in a row's context menu, rebuilds the request from
  the log (`rebuildRequest`).
- **Branch from here**, on a model call or tool run, checks the thread out there
  (`Threads.checkout`): the next prompt continues from it.
- **Keys.** `/`, Ctrl+F, or ⌘F focuses the filter. Escape closes the menu, else
  clears the filter, else closes the details, else is left to the app.
- **A tool's body** is the View tab of its tool runs. It gets the logged call
  and result, no live `output`, and `state` `interrupted` for a run without a
  result.
