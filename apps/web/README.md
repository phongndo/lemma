# @lemma/web

The web app, and how to change any part of it. It is a composition of plugins
on the same kernel as the host (`@lemma/core`): every part — the models of
host state, the frame, the sidebar, the chat, the composer, the palette, each
settings section — is a plugin that can be turned off or replaced. With every
plugin off, the page is blank.

```sh
nix develop -c pnpm --filter @lemma/web dev    # http://127.0.0.1:5173/?mock runs against an in-browser fake host
nix develop -c pnpm --filter @lemma/web test
```

## How it runs

[`ui/boot.tsx`](src/ui/boot.tsx) plans the composition from three inputs and
renders whatever fills the `root` slot:

1. The bundled plugins, listed in [`plugins/index.ts`](src/plugins/index.ts).
2. UI files in `~/.lemma/ui/` and, for a trusted project, `<project>/.lemma/ui/`:
   `.js`/`.mjs` files load as plugins, `.css` files apply over the app's
   styles (every color, radius, width, and stacking level is a `--` token in
   [`styles.css`](src/styles.css), and the app's own styles sit in cascade
   layers a file's rules always win over).
3. The `"ui"` rows of `config.jsonc`, which work like `"plugins"` rows do for
   the host: `{ "ui": { "composer": { "enabled": false }, "chat": { "config": { "expandTools": true } } } }`.

The host serves the files (under `/api`, with the token) and tells the page
when any input changes, so edits apply without a reload: only the plugins that
changed, and what depends on them, restart. The planner is the host's own
(`resolveComposition`), so turning a plugin off halts the plugins that need it,
and they return with it. A plugin from a file with a bundled plugin's id runs
in its place; one that provides a capability a bundled plugin provides turns
that plugin off unless a row says otherwise.

Change the rows from the Plugins settings page, an inspector over the host's
plugins and the web app's: a table to filter (`is:failed kind:web -is:off`)
and, for the selected plugin, why it is in its state, its wiring (what it
provides and requires and who is on the other end, the hooks and events it
takes part in, and what it contributes: tools, commands, slot items), its
settings form (from its config Schema), and its
recent faults. Or from a shell:

```sh
lemma ui                               # rows and files
lemma plugins show agent               # a host plugin's wiring and faults, as the inspector shows them
lemma ui disable sidebar               # (--project for the project's config)
lemma ui config chat expandTools true  # one config field; --unset removes it
```

Shortcuts are config too: every action (anything the palette lists) can have
keys. Settings › Keyboard (`mod+/`) records them and writes the `keymap`
plugin's `bindings`, one line per action, which a file edit changes as well:

```jsonc
{ "ui": { "keymap": { "config": { "bindings": ["shell.toggle-sidebar = mod+shift+y", "thread.view.trajectory ="] } } } }
```

Nothing after `=` unbinds an action; the composer's send key is the
`composer` plugin's `send` (`enter` or `mod+enter`). While a turn runs, the send
key steers it (the prompt joins after its current step) and Alt with it queues
the prompt for after the turn; queued prompts show above the composer, where
each can be withdrawn. A thread opened or reconnected midway shows what the
running turn has produced so far (`Agent.View`).

Typing `@` at the start of a word in the composer offers the project's files
and folders, searched on the host as you type (fuzzy, typos forgiven,
`.gitignore` honoured); arrows move, Enter or Tab writes the pick as a path
(`@src/app.ts`, relative to the thread's directory, which the agent reads like
any path; `@"my notes/a b.md"` with spaces), and Escape closes the menu.
Picking a folder writes `@src/` and goes on completing inside it, as typing a
folder that exists before a `/` does. That is the `file-mentions` plugin,
configured like any other (`trigger`, `limit`, `folders`), on the host's
`file-search` plugin, which `lemma workspace files <query>` uses too; either
can be turned off or replaced.
Any plugin can add its own trigger, or more suggestions for `@`, with a
`ComposerCompletions` item:

```js
// ~/.lemma/ui/thread-links.js: `#` offers threads by title
export default ({ defineUiPlugin, contracts: { Slots, Threads, ComposerCompletions } }) =>
  defineUiPlugin({
    id: "thread-links",
    requires: { slots: Slots, threads: Threads },
    setup: ({ slots, threads }, plugin) => {
      const suggest = (query) =>
        threads
          .list()
          .filter((thread) => thread.title?.toLowerCase().includes(query.toLowerCase()))
          .map((thread) => ({ key: thread.id, label: thread.title, insert: `[${thread.title}](${threads.href(thread.id)})` }));
      plugin.onCleanup(slots.add(ComposerCompletions, { id: "thread-links", trigger: "#", label: "Threads", suggest }));
    },
  });
```

Open the app with `?safe` to ignore rows and files: the way back from a
customization that broke the page, including one that turned the settings off.

## Addresses

The page's address names what it shows, so links, reloads, and back and
forward return to it. The routes are declared in
[`@lemma/contracts`](../../packages/contracts/src/addresses.ts), shared with
the desktop app's `lemma://` links and `lemma open`:

| Address                                 | Shows                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/`                                     | A new thread                                                                                                 |
| `/threads/<id>`, `/threads/<id>/<view>` | A thread, in its first view or the one named (`trajectory`, or any `Views` item's id)                        |
| `/settings/<section>?…`                 | A settings section; the search is the section's own state (`/settings/plugins?plugin=agent&kind=host&tab=…`) |

`?safe` and `?mock` stay on every navigation. The `router` plugin
([`@lemma/router`](../../packages/router/README.md), with
[`@lemma/router-solid`](../../packages/router-solid/README.md)) follows the address and
the `pages` plugin shows the `Pages` item for its route in the main region. A
route whose page's plugin is off says so, at the same address, until the
plugin returns. Any `<a href>` to the app navigates in place on a plain click.
A plugin adds a page of its own with `api.defineRoute` and a `Pages` item:

```js
const Note = api.defineRoute("notes.note", { path: "/notes/:id" }); // params: { id: string }
slots.add(Pages, { id: "notes.note", route: Note, component: NotePage });
// <a href={router.href(Note, { id })}>, or router.navigate(Note, { id }); the page reads router.matchOf(Note)
```

`router.matchOf(route)` runs again only when that route's match changes, not on
every navigation. A `Pages` item's optional `preload(match)` runs when a link to
it is hovered or focused (thread rows fetch the thread's log, so it opens at
once). A blocker (`router.block`) also hears `action: "unload"` before the tab
closes or reloads: the composer refuses it while there is unsent text, so the
browser asks first. A page that throws fails alone: the main region says so and
names its plugin, and it is tried again on retry or the next navigation. Two
plugins' routes in conflict (one id, or the same addresses with nothing to tell
them apart) show a warning; the app still shows one of them.

## Devtools

`mod+shift+d` docks the devtools under the app. They show it as it runs and
change nothing; the Plugins page is where things change.

- **Routes**: every route and its verdict on an address (shown, outranked by a
  more specific route, params rejected, no match, and why), who shows each and
  what it overrides, conflicts, blockers.
- **Navigation**: the router's journal and the state kept with each history
  entry.
- **Host events**: everything the host publishes, as `lemma events` shows it;
  a session opens its thread's trajectory.
- **Plugins**, for the web app and the host alike (both run the core): one
  plugin and everything it does: its state and why, what it provides (and who
  uses it) and requires (and who provides it), its place in each hook's chain,
  the events it observes, what it contributes (each slot item; on the host,
  its inspectors), its settings and recent faults. A plugin's name anywhere in
  the devtools opens it here.
- **Hooks**: each hook's chain in run order, and each event's observers.
- **Registries**: every slot, live, with who fills it and how to add to it;
  the host's registries and their contributors.
- **Inspectors**: what host plugins let you look into (registered tools,
  running turns, commands), refreshed while open.

Two ways to extend them, both plugins:

- A web plugin adds a panel with a `DevtoolsPanels` item, drawn with the
  foundation's `.dt-*` classes (toolbar, filter, chips, table, details pane,
  status bar; see `src/styles.css`) so it looks like the other panels and the
  Trajectory. Its `snapshot` is the panel's data as JSON:
  `Devtools.snapshot()` collects every panel's. `devtools.show(panel, subject)`
  opens a panel at something, as plugin names open `PLUGIN_PANEL`.
- A host plugin adds an inspector to the `Inspectors` registry
  (`@lemma/contracts`) with `PluginContext.add`, requiring nothing: an id, a
  title, and a `snapshot` Effect returning JSON. An array of objects shows as a
  table. It appears in the Inspectors panel and in `lemma inspectors`.

## Writing a plugin

A plugin requires capabilities, provides capabilities, and contributes to
slots. [`ui/contracts.ts`](src/ui/contracts.ts) lists them all; the bundled
plugins use nothing else.

- **Capabilities** are services with one provider: the host's state
  (`Threads`, `Models`, `Workspace`, `HostPlugins`, `Commands`,
  `Interactions`, the `Client` connection) and screen state (`Router`,
  `Dialogs`, `Settings`, `Layout`, `Devtools`). Replacing a provider restarts its
  dependents with the new one.
- **Slots** are places any number of plugins add to: regions of the screen
  (`Root`, `SidebarRegion`, `MainRegion`, `ComposerRegion`, …), where
  the first item by `order` shows, and lists: `Layers` (over the app),
  `Docks` (under it), `Pages` (what shows at a route),
  `Actions` (the palette and shortcuts), `Views`, `SettingsSections`, `SettingsGroups`, `ToolViews` (a
  tool's summary and body, in the chat and the trajectory), `CodeBlocks` (how
  fenced code renders: `highlight` and `diagrams` fill it), `PaletteSources`
  (what the palette searches), `ThreadHeader`, `SidebarActions`,
  `ThreadActions` and `ProjectActions` (the sidebar's ⋯ menus),
  `ComposerActions`, `ComposerCompletions` (what a word typed after a
  trigger can become: `file-mentions` fills `@`), `WorkspaceBarItems`, `PluginTabs` (the Plugins page
  inspector), `DevtoolsPanels`, `TrajectoryTabs` and `TrajectoryActions`. The bundled plugins add
  their own buttons, tabs, and sources through these same slots. Take over a
  region by adding with a lower `order`, or turn its plugin off. An item leaves
  when the plugin that added it stops.
- **Parts** are the pieces plugins draw with, each a region-like slot: the
  shared ones (`markdown`, `dialog`, `popover`, `toggle`, `setting-row`,
  `segmented`, `config-form`, `provider-logo`, `search-field` (a page's search), `icon` for every icon, and
  `file-icon` for a file's or folder's, all from the `kit` plugin) and a view's own (`chat.user`, `chat.thinking`,
  `chat.tool`, `chat.work`, `chat.working`, `chat.turn-footer`,
  `composer.queued`, `composer.suggestion`, `sidebar.row`, `providers.row`). Replace one
  everywhere by adding an item with an `order` below `DEFAULT_PART_ORDER`;
  `api.defaults` holds the bundled implementations to wrap or fall back to.

```js
// ~/.lemma/ui/quiet-thoughts.js: thoughts as a single muted line, never expanded
export default ({ defineUiPlugin, contracts: { Slots, ChatThinkingPart }, html }) =>
  defineUiPlugin({
    id: "quiet-thoughts",
    requires: { slots: Slots },
    setup: ({ slots }, plugin) => {
      plugin.onCleanup(slots.add(ChatThinkingPart, { id: "quiet", order: 0, component: (props) => html`<p class="muted small">thought for a moment</p>` }));
    },
  });
```

[`defineUiPlugin`](src/ui/define.ts) writes one in plain TypeScript. `setup`
runs in its own Solid root; release what it adds with `plugin.onCleanup`. Its
`styles` (a stylesheet as a string) apply while it runs and leave with it. A
plugin can declare its own slots and parts for others (`defineSlot`,
`definePart`); a name is one slot across the page, so files that use the same
name share it.

A file needs no build step: its default export may be a function that receives
[the api](src/ui/api.ts) — the page's Solid, the contracts, `defineUiPlugin`,
the parts (`components`, `icons`, `parts`) and their `defaults`, and `html`,
Solid's JSX without a compiler.

```js
// ~/.lemma/ui/tool-count.js
export default ({ defineUiPlugin, contracts: { Slots, Threads, SidebarFooter }, html }) =>
  defineUiPlugin({
    id: "tool-count",
    requires: { slots: Slots, threads: Threads },
    setup: ({ slots, threads }, plugin) => {
      const calls = () => threads.branch().filter((event) => event.data.type === "message" && event.data.message.role === "toolResult").length;
      plugin.onCleanup(slots.add(SidebarFooter, { id: "tool-count", order: 50, component: () => html`<span class="muted small">${calls} tool calls</span>` }));
    },
  });
```

Give it a `config` Schema (from `api.Schema`) and its fields appear on the
Plugins page. A file is one ES module: bundle anything it imports, and import
nothing it can get from the api, so it shares the page's module instances.
UI files run with the page's permissions and token, like host plugins run with
the host's.
