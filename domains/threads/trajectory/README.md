# threads.trajectory

Shows the open thread as the requests and tool runs behind it, as Chrome
DevTools' Network panel shows a page's: a filter toolbar, an overview of the
thread's time in three lanes (prompts, model calls, tools), a sortable table
with a waterfall column, a details panel in tabs, and a status bar with the
totals of the rows shown. A model call's or tool run's Pipeline tab says what
shaped it, plugin by plugin. Adds the `trajectory` view to `Views` (order 10,
without the composer), and draws what plugins add to `TrajectoryTabs` and
`TrajectoryActions`, and each tool's `ToolViews` body
([`@lemma/threads`](../contract/src/threads.ts)). Everything is projected from
`Threads.branch` with `trajectory` and `ledger`
([`@lemma/sessions`](../../sessions/contract/src/ledger.ts)): a row for the
system prompt when first sent or changed, each prompt, each model call (a
failed attempt too), and each tool run. Requires `Threads` and the runtime's
`Notify` and `Slots`. No config.

## Behavior

- **The filter** takes `parseLedgerFilter`'s terms (`is:error`, `tool:bash`,
  `turn:2`, …); the kind chips narrow it further.
- **The time axis.** Time within a turn is to scale; the idle time between
  turns shrinks to a sliver, so one long pause does not squash every turn. The
  wheel zooms around the pointer and a sideways wheel pans, as does dragging
  with the right button; dragging selects a time range and fades the rows
  outside it; a double-click shows the whole thread.
- **Following.** Sorted by time, the table keeps its newest row in view as rows
  arrive, until the reader scrolls up; Follow brings it back. Grouping by turn
  holds in time order only: a table sorted otherwise is flat.
- **The pipeline**, from the log: for a model call, the compactions before its
  request, the `AgentRequestHook` handlers (each one's own time and what it
  changed), the failed attempts and when each was asked again, the answer, the
  `LlmProviderHeadersHook` handlers, and why the turn went on or stopped
  (`AgentContinueHook`); for a tool run, the `ToolExecuteHook` handlers, the
  guards' decisions, and where the registry cut the result.
- **The context menu** inspects a record's request, copies it as sent (rebuilt
  from the log with `rebuildRequest`), copies the record's payload, result,
  text, or JSON, filters by its tool or turn, and on a model call or tool run,
  branches from it (`Threads.checkout`): the next prompt continues from there.
- **Keys.** Arrow keys move the selection, and `/`, Ctrl+F, or ⌘F focuses the
  filter. Escape closes the menu, else clears the filter being typed in, else
  closes the details; with none of those, it is left to the app.
- **A tool's body** is the View tab of its tool runs, before the tabs plugins
  add. It gets the logged call and result, no live `output`, and `state`
  `interrupted` for a run without a result, running or not.
