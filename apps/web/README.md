# @lemma/web

The web app, and how to change any part of it. It is a composition of plugins
on the same kernel as the host: the models of host state, the frame, the
sidebar, the chat, the composer, the palette, and each settings section are
plugins that can be turned off or replaced. They are written against the
app's runtime, which no plugin replaces: the connection to the host, slots,
the router, messages, the plugins, and the host's questions. With every
plugin off, the page is blank, and the runtime still runs.

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
plugin's config, which Settings › Keyboard records. The runtime is not a
plugin: it has no row, and the Plugins page lists what it provides in its
summary.

A customization that breaks fails alone. A plugin that cannot run (a file
that does not load, a config that does not decode, a plugin written for
another `api`, a plugin providing what the runtime provides) is left out with
what needs it, and one that fails to start is left failed; the Plugins page
says why. A slot item that throws while it draws is reported as its plugin's
fault and leaves the slot, so a replaced part shows its default again, and a
plugin whose own effects throw stops, with what needs it, while the rest of
the page keeps updating. Open the app with `?safe` to ignore rows and files,
the way back from a customization that broke the frame itself.

### The look

Every color, font, font size, radius, and drop shadow is a `--` token, and
every plugin draws with them, so one change restyles them all. Widths and
spacing are layout, not tokens (a 1px ring drawn with `box-shadow` is a
border: its color is a token). Each token's default is
Lemma's own look; customizing only sets tokens over it. Colors start from
three base colors, `--bg`, `--text`, and `--accent`, and
[`styles.css`](src/styles.css) derives surfaces, muted text, and the accent's
tint from them. A plugin's own colors are tokens in its stylesheet:
`highlight`'s `--code-*` (GitHub's colors until set), `diagrams'`
`--diagram-*` (Mermaid's own until set). `--text-scale` sizes every font and
`--radius-scale` rounds every corner.

The look is the `appearance` plugin's config, which it paints on the page:

```jsonc
"ui": { "appearance": { "config": {
  "scheme": "dark",              // system (the default), light, or dark
  "darkTheme": "tokyo-night",    // a theme a plugin offers; unset, Lemma's own
  "accent": "blue",              // an accent a plugin offers, or any CSS color
  "monoFont": "jetbrains-mono",  // a font a plugin offers, or a CSS font-family list
  "textSize": "large",           // small, default, large, or larger
  "corners": "round",            // square, default, or round
  "contentWidth": "wide"         // default, wide, or full
} } }
```

Settings › Appearance (the `appearance-page` plugin) edits that row, as
`lemma ui config appearance accent blue` or an agent's edit to `config.jsonc`
does, and the palette's Appearance commands switch the scheme. What there is
to choose from is three slots, `Themes`, `Accents`, and `Fonts`: `appearance`
adds Lemma's own there, and a plugin adds others beside them, so a theme pack
is a UI file, offered while it loads and gone with it. A theme is its base
colors, and `tokens` for any other:

```js
// ~/.lemma/ui/tokyo-night.js
export default ({ defineUiPlugin, contracts: { Slots, Themes, Accents } }) =>
  defineUiPlugin({
    id: "tokyo-night",
    requires: { slots: Slots },
    setup: ({ slots }) => {
      slots.add(Themes, {
        id: "tokyo-night",
        title: "Tokyo Night",
        scheme: "dark",
        colors: { bg: "#1a1b26", text: "#c0caf5", accent: "#7aa2f7" },
        tokens: { "--code-keyword": "#bb9af7", "--code-string": "#9ece6a", "--diagram-node": "#24283b" },
      });
      slots.add(Accents, { id: "teal", title: "Teal", color: "oklch(0.62 0.11 190)" });
    },
  });
```

A font plugin declares its file with `@font-face` in its `styles` and adds a
`Fonts` item; the file loads only once the font is chosen. A plugin's rows in
the `SectionIds.appearance` settings section sit beside the look's own. A
stylesheet in `~/.lemma/ui` sets any token the look leaves unset, and a
plugin that replaces `appearance` paints through `api.look` (`paint`,
`unpaint`), so the next load shows its look before plugins start; a renderer
that does not draw with CSS reads the look there too (`tokenColor`,
`onLookChange`).

### Utilities

A UI file's markup can use Tailwind utilities, prefixed `tw:`, as the bundled
plugins do:

```js
html`<div class="tw:flex tw:gap-2 tw:bg-bg-raised tw:rounded">${label}</div>`;
```

Each is named for its token, not Tailwind's palette: `--x` is the value `x`
(`tw:bg-bg-raised`, `tw:text-text-2`, `tw:border-border`, `tw:bg-accent`;
[`tailwind.css`](src/tailwind.css)), so they follow the look. While a UI file has a script, the page
compiles its classes with the app's own; a class must appear whole in the
file, as Tailwind requires. A plugin's `styles` and the stylesheets in
`~/.lemma/ui` are plain CSS: Tailwind's `@apply` does not reach them, and the
tokens do.

## Writing a plugin

A plugin requires and provides capabilities, and adds items to slots.
[`ui/contracts.ts`](src/ui/contracts.ts) declares them all, and the bundled
plugins use nothing else:

- **Capabilities** are services with one provider, such as `Threads` or
  `Models`. The runtime's ([`ui/runtime.ts`](src/ui/runtime.ts): `Client`,
  `Slots`, `Router`, `Notify`, `HostPlugins`, `Interactions`, `UiPlugins`)
  the app provides itself; every other comes from a plugin.
- **Slots** are places any number of plugins add to: regions of the screen,
  where the first item by `order` shows, and lists such as `Actions` (the
  palette and shortcuts) or `ComposerCompletions`. A plugin adds through the
  `Slots` its setup receives, and an item leaves when the plugin that added it
  stops.
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
    setup: ({ slots, threads }) => {
      const calls = () => threads.branch().filter((event) => event.data.type === "message" && event.data.message.role === "toolResult").length;
      slots.add(SidebarFooter, { id: "tool-count", order: 50, component: () => html`<span class="muted small">${calls} tool calls</span>` });
    },
  });
```

```js
// ~/.lemma/ui/quiet-thoughts.js: thoughts as a single muted line
export default ({ defineUiPlugin, contracts: { Slots, ChatThinkingPart }, html }) =>
  defineUiPlugin({
    id: "quiet-thoughts",
    requires: { slots: Slots },
    setup: ({ slots }) => {
      slots.add(ChatThinkingPart, { id: "quiet", order: 0, component: () => html`<p class="muted small">thought for a moment</p>` });
    },
  });
```

```js
// ~/.lemma/ui/thread-links.js: `#` in the composer offers threads by title
export default ({ defineUiPlugin, contracts: { Slots, Threads, ComposerCompletions } }) =>
  defineUiPlugin({
    id: "thread-links",
    requires: { slots: Slots, threads: Threads },
    setup: ({ slots, threads }) => {
      const suggest = (query) =>
        threads
          .list()
          .filter((thread) => thread.title?.toLowerCase().includes(query.toLowerCase()))
          .map((thread) => ({ key: thread.id, label: thread.title, insert: `[${thread.title}](${threads.href(thread.id)})` }));
      slots.add(ComposerCompletions, { id: "thread-links", trigger: "#", label: "Threads", suggest });
    },
  });
```

`defineUiPlugin` is the kernel's promise-based `definePlugin`
([`@lemma/core/plain`](../../packages/core/README.md#plugins-written-with-promises))
with the page's conventions. `setup` runs in its own Solid root. What it adds to slots leaves when it stops;
release anything else it holds (a listener, a timer) with `plugin.onCleanup`. A
`config` Schema (from `api.Schema`, Effect 4's Schema with Effect 3's `Literal`,
`Record`, `between`, `positive`, `nonNegative`, `optionalWith`,
`propertySignature`, and `.annotations(…)`, so a file written for Effect 3 keeps
working) becomes the plugin's settings form. `styles` apply while it runs.
`api: 2` says which version of
the contracts it is written for (`contracts.UI_API`), so a later incompatible
version leaves it out, saying so, rather than letting it fail at a call;
`routes` lists the routes it shows pages at, so their addresses name it while
it is off. Draw what a slot holds with `api.parts.Contained`, `Each`, or
`First`, so an item that throws fails alone. A file is one ES module: bundle
anything it imports, and take from the api what it offers, so it shares the
page's module instances. UI files run with the page's permissions and token,
as host plugins run with the host's.

A host plugin serves its own UI through
[`Channels`](../../packages/contracts/src/channels.ts): a UI plugin requires
`Client` and calls `client.host.channel.call(id, payload)`, or follows a
stream with `client.host.channel.open(id, payload, onElement, onEnd)`, opening
it again on `client.onConnect`, when it ends `Withdrawn`, and on a
`channels-changed` host event that lists it while it is closed. A plugin with a
build step passes the channel's declaration instead of its id and is typed by
it: the payload and the results go through its schemas.
[`examples/ticker`](../../examples/ticker/README.md) is a host plugin file and a
UI file that shows its prices at `/ticker`.

A replacement with a bundled plugin's id can wrap it rather than copy it, and
so keep what it gains in later versions: `api.bundled` holds the bundled
plugins, and `api.extendUiPlugin` makes a plugin from another's definition.
The runtime is not in `api.bundled`, and a plugin providing one of its
capabilities is left out: draw messages differently by replacing `toasts`,
which decides how long each shows, rather than `Notify`.

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
forward return to it. The app's own routes are known whatever plugins run (the
boot's `appRoutes`): a session's in
[`@lemma/contracts`](../../packages/contracts/src/sessions.ts), shared with the
desktop app's `lemma://` links and `lemma open`, and settings' in
[`ui/contracts.ts`](src/ui/contracts.ts):

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
  setup: ({ slots }) => {
    slots.add(Pages, { id: "notes.note", route: Note, component: NotePage });
  },
});
// <a href={router.href(Note, { id })}>, or router.navigate(Note, { id }); the page reads router.matchOf(Note)
```

A page whose plugin is off or failed says so at the same address, naming the
plugin, until it returns, and a page that throws fails alone.

## Devtools

`mod+shift+d` docks the devtools under the app: routes, navigation, host
events, and, for the web app and the host alike, plugins, hooks, registries,
and inspectors. A capability the runtime provides shows as the web app's or
the host's, not as missing. They show the app as it runs; the Plugins page is
where things change. A web plugin adds a panel with a `DevtoolsPanels` item,
and a host plugin adds an inspector to the `Inspectors` registry
(`@lemma/contracts`), which also shows in `lemma inspectors`.
