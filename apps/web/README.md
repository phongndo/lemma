# @lemma/web

The web app, and how to change any part of it. It is a composition of plugins
on the same kernel as the host: the models of host state, the frame, the
sidebar, the chat, the composer, the palette, and each settings section are
plugins that can be turned off or replaced. With every plugin off, the page is
blank.

```sh
nix develop -c pnpm --filter @lemma/web dev    # http://127.0.0.1:5173/?mock runs against an in-browser fake host
nix develop -c pnpm --filter @lemma/web test
```

While a turn runs, sending steers it (the prompt joins after its current step),
and Alt with the send key queues the prompt for after the turn.

## Customize

[`ui/boot.tsx`](src/ui/boot.tsx) plans the composition from three inputs:

1. The bundled plugins, listed in [`plugins/index.ts`](src/plugins/index.ts).
2. UI files in `~/.lemma/ui/` and, for a trusted project, `<project>/.lemma/ui/`:
   `.js`/`.mjs` files load as plugins, and `.css` files apply over the app's
   styles. Every color, radius, width, and stacking level is a `--` token in
   [`styles.css`](src/styles.css), and a file's rules win over the app's own.
3. The `"ui"` rows of `config.jsonc`, which work like the host's
   [`"plugins"` rows](../../docs/configuration.md):
   `{ "ui": { "chat": { "config": { "expandTools": true } } } }`.

Edits apply without a reload: the plugins that changed, and what depends on
them, restart. Change rows from the Plugins settings page or with
`lemma ui enable|disable|config`. Keyboard shortcuts are the `keymap`
plugin's config, which Settings › Keyboard records.

A customization that breaks fails alone. A plugin that cannot run (a file
that does not load, a config that does not decode, a plugin written for
another `api`) is left out with what needs it, and one that fails to start is
left failed; the Plugins page says why. A slot item that throws while it draws
is reported as its plugin's fault and leaves the slot, so a replaced part
shows its default again, and a plugin whose own effects throw stops, with what
needs it, while the rest of the page keeps updating. Open the app with `?safe`
to ignore rows and files, the way back from a customization that broke the
frame itself.

## Writing a plugin

A plugin requires and provides capabilities, and adds items to slots.
[`ui/contracts.ts`](src/ui/contracts.ts) declares them all, and the bundled
plugins use nothing else:

- **Capabilities** are services with one provider, such as `Threads`,
  `Models`, or `Router`.
- **Slots** are places any number of plugins add to: regions of the screen,
  where the first item by `order` shows, and lists such as `Actions` (the
  palette and shortcuts) or `ComposerCompletions`. An item leaves when the
  plugin that added it stops.
- **Parts** are the pieces plugins draw with, such as `icon`, `dialog`, or
  `chat.tool`. Replace one everywhere by adding an item with an `order` below
  `DEFAULT_PART_ORDER`; `api.defaults` holds the bundled implementations.

The devtools' Registries panel (`mod+shift+d`) lists every slot and who fills
it.

A UI file needs no build step: its default export may be a function that
receives [the api](src/ui/api.ts), including Solid, the contracts,
`defineUiPlugin`, and `html` (Solid's JSX without a compiler).

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

```js
// ~/.lemma/ui/quiet-thoughts.js: thoughts as a single muted line
export default ({ defineUiPlugin, contracts: { Slots, ChatThinkingPart }, html }) =>
  defineUiPlugin({
    id: "quiet-thoughts",
    requires: { slots: Slots },
    setup: ({ slots }, plugin) => {
      plugin.onCleanup(slots.add(ChatThinkingPart, { id: "quiet", order: 0, component: () => html`<p class="muted small">thought for a moment</p>` }));
    },
  });
```

```js
// ~/.lemma/ui/thread-links.js: `#` in the composer offers threads by title
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

`setup` runs in its own Solid root; release what it adds with
`plugin.onCleanup`. A `config` Schema (from `api.Schema`) becomes the plugin's
settings form, and `styles` apply while it runs. `api: 1` says which version of
the contracts it is written for (`contracts.UI_API`), so a later incompatible
version leaves it out, saying so, rather than letting it fail at a call;
`routes` lists the routes it shows pages at, so their addresses name it while
it is off. Draw what a slot holds with `api.parts.Contained`, `Each`, or
`First`, so an item that throws fails alone. A file is one ES module: bundle
anything it imports, and take from the api what it offers, so it shares the
page's module instances. UI files run with the page's permissions and token,
as host plugins run with the host's.

A replacement with a bundled plugin's id can wrap it rather than copy it, and
so keep what it gains in later versions: `api.bundled` holds the bundled
plugins, and `api.extendUiPlugin` makes a plugin from another's definition.

```js
// ~/.lemma/ui/toasts.js: the bundled toasts, logging each one too
export default ({ bundled, extendUiPlugin }) =>
  extendUiPlugin(bundled.toasts, (base) => ({
    ...base,
    setup: (use, plugin) => {
      const made = base.setup(use, plugin);
      console.log("toasts started");
      return made;
    },
  }));
```

## Addresses

The page's address names what it shows, so links, reloads, and back and
forward return to it. The routes are declared in
[`@lemma/contracts`](../../packages/contracts/src/addresses.ts), shared with
the desktop app's `lemma://` links and `lemma open`:

| Address                                 | Shows                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `/`                                     | A new thread                                                                          |
| `/threads/<id>`, `/threads/<id>/<view>` | A thread, in its first view or the one named (`trajectory`, or any `Views` item's id) |
| `/settings/<section>?…`                 | A settings section; the search is the section's own state                             |

A plugin adds a page with `api.defineRoute` and a `Pages` item, routed by
[`@lemma/router`](../../packages/router/README.md), and lists the route in its
`routes`:

```js
const Note = api.defineRoute("notes.note", { path: "/notes/:id" }); // params: { id: string }
api.defineUiPlugin({
  id: "notes",
  routes: [Note],
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    plugin.onCleanup(slots.add(Pages, { id: "notes.note", route: Note, component: NotePage }));
  },
});
// <a href={router.href(Note, { id })}>, or router.navigate(Note, { id }); the page reads router.matchOf(Note)
```

A page whose plugin is off or failed says so at the same address, naming the
plugin, until it returns, and a page that throws fails alone.

## Devtools

`mod+shift+d` docks the devtools under the app: routes, navigation, host
events, and, for the web app and the host alike, plugins, hooks, registries,
and inspectors. They show the app as it runs; the Plugins page is where things
change. A web plugin adds a panel with a `DevtoolsPanels` item, and a host
plugin adds an inspector to the `Inspectors` registry (`@lemma/contracts`),
which also shows in `lemma inspectors`.
