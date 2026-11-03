# devtools.dock

The devtools: a dock under the app (`mod+shift+d`) whose tabs are the
`DevtoolsPanels` items, for looking into the app as it runs; the Plugins page
is where things change. Provides `Devtools`
([`@lemma/devtools/web`](../contract/src/web/index.ts)). Adds the dock to
`Docks` ([`@lemma/frame`](../../frame/contract/src/index.ts)), its own panels to
`DevtoolsPanels`, and two items to `Actions`: `devtools.toggle` (`mod+shift+d`,
even while typing or with a dialog open) and `event-log.open`
(`DevtoolsActionIds.eventLog`: Show host events). No config.

| Panel                 | What it shows                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devtools.routes`     | Every route and its verdict on an address (the page's, or one typed): the `Pages` item that shows it, its plugin, and why the other routes do not                                                                            |
| `devtools.navigation` | The router's journal, newest first, and what is kept with the current history entry                                                                                                                                          |
| `devtools.events`     | What the page hears from the host, its last 1000 lines: `Host.Events`, the connection's changes, and, while the dock is open, the domains' streams (`sessions.changes`, `agent.activity`, `llm.changes`, `commands.changes`) |
| `devtools.channels`   | The channels host plugins serve, each with the plugin answering for it                                                                                                                                                       |
| `devtools.plugins`    | Either app's plugins, and all one does: what it provides and requires, its place in each hook's chain, what it observes, adds, and inspects, its settings, and its faults                                                    |
| `devtools.hooks`      | Either app's hooks, each chain in run order, or its events and their observers                                                                                                                                               |
| `devtools.registries` | The web app's slots (their items, which one shows, and the code that adds to one), or the host's registries                                                                                                                  |
| `devtools.inspectors` | What host plugins add to `Inspectors`, read again every 2s while shown, as tables when a snapshot has their shape                                                                                                            |

Its tabs show in that order; a panel of yours sits among them by `order`,
whose values are in [its source](src/index.tsx). `devtools.trace` adds the
Trace panel ([its README](../trace/README.md#the-trace-panel)).

## Behavior

- **Kept for the tab's life** (`lemma.devtools` in `sessionStorage`): whether
  it is open, which panel, and its height. Drag its top edge, or press ↑ or ↓
  while it has focus, for 160px to 85% of the window. A double-click or Enter
  resets it to 320px.
- **Keys.** A panel's table selects with ↑ and ↓ and opens a row with Enter.
  Escape clears a filter being typed in. Any panel gets these by drawing its
  table and filter with `SelectableTable` and `FilterField`, or with `rowKeys`
  and `clearsOnEscape` on its own markup
  ([`@lemma/devtools/web`](../contract/src/web/controls.tsx)). A click on a
  button or link in a row is that control's, not the row's. While focus is in
  the dock, "/" and Ctrl/Cmd+F focus the panel's filter, its first
  `.dt-filter` input.
- **Subjects.** `devtools.plugins` takes a plugin's id (see `show`), and
  `devtools.inspectors` an inspector's id. The other panels take none.
- **Host events.** A model's and a tool's streamed output are hidden until
  **Deltas** is on.

## Rationale

- **Streams only while open.** The host's own events and the connection are
  recorded from the start, so the log shows what came before the dock was
  opened. Following the domains' streams costs the page a subscription of its
  own, the agent's output included, so that runs only while the dock is open.
- **A replacement** providing `Devtools` draws the `DevtoolsPanels` items and
  answers `subject` for them, and keeps `devtools.plugins` (`PLUGIN_PANEL`) the
  panel that shows one plugin: `devtools.trace` requires `Devtools` and links
  there.
