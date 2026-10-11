# devtools.dock

The devtools: a dock under the app (`mod+shift+d`) whose tabs are the
`DevtoolsPanels` items, for looking into the app as it runs; the Plugins page
is where things change. Provides `Devtools`
([`@lemma/devtools/web`](../contract/src/web/index.ts)). Adds the dock to
`Docks` ([`@lemma/frame`](../../frame/contract/src/index.ts)), its own panels to
`DevtoolsPanels`, and `devtools.toggle` (`mod+shift+d`, even while typing or
with a dialog open) and `event-log.open` (`DevtoolsActionIds.eventLog`: Show
host events) to `Actions`. Requires `Slots`, `Router`, `Client`, `WebPlugins`,
and `HostPlugins`. No config.

| Panel                 | Order | What it shows                                                                                                                                                                                                                |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devtools.routes`     | 0     | Every route and its verdict on an address (the page's, or one typed): the `Pages` item that shows it, its plugin, and why the other routes do not                                                                            |
| `devtools.navigation` | 10    | The router's journal, newest first, and what is kept with the current history entry                                                                                                                                          |
| `devtools.events`     | 15    | What the page hears from the host, its last 1000 lines: `Host.Events`, the connection's changes, and, while the dock is open, the domains' streams (`sessions.changes`, `agent.activity`, `llm.changes`, `commands.changes`) |
| `devtools.channels`   | 16    | The channels host plugins serve, each with the plugin answering for it                                                                                                                                                       |
| `devtools.plugins`    | 20    | Either app's plugins, and all one does: what it provides and requires, its place in each hook's chain, what it observes, adds, and inspects, its settings, and its faults                                                    |
| `devtools.hooks`      | 30    | Either app's hooks, each chain in run order, or its events and their observers                                                                                                                                               |
| `devtools.registries` | 40    | The web app's slots (their items, which one shows, and the code that adds to one), or the host's registries                                                                                                                  |
| `devtools.inspectors` | 50    | What host plugins add to `Inspectors`, read again every 2s while shown, as tables when a snapshot has their shape                                                                                                            |

`devtools.trace` adds the Trace panel
([its README](../trace/README.md#the-trace-panel)).

## Behavior

- **It lasts the tab's life.** Whether it is open, which panel, and its height
  (drag its top edge, from 160px to 85% of the window) are kept in
  `sessionStorage`.
- **Subjects.** Besides `devtools.plugins` (see `show`), `devtools.inspectors`
  takes one, an inspector's id; the other panels take none. A plugin's name in
  a panel opens it in `devtools.plugins`, whose details link to its row on the
  Plugins page and, while the Trace panel is there, to its spans.
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
