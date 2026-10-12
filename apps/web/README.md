# @lemma/web-app

The web app, and how to change any part of it. It is a composition of plugins
on the same kernel as the host: the models of host state, the frame, the
sidebar, the chat, the composer, the palette, and each settings section are
plugins that can be turned off or replaced. They are written against the
app's runtime, which no plugin replaces: the connection to the host, slots,
the router, messages, the plugins, and the host's questions. With every
plugin off, the page is blank, and the runtime still runs.

```sh
nix develop -c pnpm --filter @lemma/web-app dev    # http://127.0.0.1:5173/?mock runs against an in-browser fake host
nix develop -c pnpm --filter @lemma/web-app test
```

While a turn runs, sending queues the prompt for after the turn, Alt with the
send key steers the turn instead (the prompt joins after its current step), and
Escape twice stops it; the [composer](../../domains/threads/composer/README.md)
has the settings for both.

## Customize

[`ui/boot.tsx`](src/ui/boot.tsx) plans the composition from three inputs:

1. The bundled plugins, listed in [`bundled.ts`](src/bundled.ts): each a package in its domain's folder
   (`domains/<domain>/<name>`, id `<domain>.<name>`), as `frame.shell` is `domains/frame/shell`.
2. Web halves and stylesheets in `~/.lemma/plugins/` and, for a trusted
   project, `<project>/.lemma/plugins/` (laid out as
   [Configuration](../../docs/configuration.md#your-plugins) says): a web half
   (`notes.web.js`, a folder plugin's `lemma.web`) loads as a plugin, and a
   stylesheet applies over the app's styles. Every color, radius, width, and
   stacking level is a `--` token in [`styles.css`](src/styles.css), and a
   stylesheet's rules win over the app's own.
3. The rows of `config.jsonc`, the host's too: one row decides both halves of
   a plugin (`{ "plugins": { "threads.transcript": { "config": { "expandTools": true } } } }`),
   and a web half whose host half is not running waits for it.

Edits apply without a reload: the plugins that changed, and what depends on
them, restart. Change rows from the Plugins settings page, which shows a
plugin's two halves as one row, or with `lemma plugins enable|disable|config`.
Keyboard shortcuts are the `actions.keymap` plugin's config, which Settings ›
Keyboard records. The runtime is not a plugin: it has no row, and the Plugins
page lists what it provides in its summary.

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

The look is the `look.appearance` plugin's config, which it paints on the page:

```jsonc
"plugins": { "look.appearance": { "config": {
  "scheme": "dark",              // system (the default), light, or dark
  "darkTheme": "tokyo-night",    // a theme a plugin offers; unset, Lemma's own
  "accent": "blue",              // an accent a plugin offers, or any CSS color
  "monoFont": "jetbrains-mono",  // a font a plugin offers, or a CSS font-family list
  "textSize": "large",           // small, default, large, or larger
  "corners": "round",            // square, default, or round
  "contentWidth": "wide"         // default, wide, or full
} } }
```

Settings › Appearance (the `look.appearance-page` plugin) edits that row, as
`lemma plugins config look.appearance accent blue` or an agent's edit to `config.jsonc`
does, and the palette's Appearance commands switch the scheme. What there is
to choose from is three slots, `Themes`, `Accents`, and `Fonts`: `look.appearance`
adds Lemma's own there, and a plugin adds others beside them, so a theme pack
is a web half, offered while it loads and gone with it. A theme is its base
colors, and `tokens` for any other:

```js
// ~/.lemma/plugins/tokyo-night.web.js
export default ({ defineWebPlugin, contracts: { Slots, Themes, Accents } }) =>
  defineWebPlugin({
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
stylesheet in `~/.lemma/plugins` sets any token the look leaves unset, and a
plugin that replaces `look.appearance` paints through `api.look` (`paint`,
`unpaint`), so the next load shows its look before plugins start; a renderer
that does not draw with CSS reads the look there too (`tokenColor`,
`onLookChange`).

### Utilities

A web half's markup can use Tailwind utilities, prefixed `tw:`, as the bundled
plugins do:

```js
html`<div class="tw:flex tw:gap-2 tw:bg-bg-raised tw:rounded">${label}</div>`;
```

Each is named for its token, not Tailwind's palette: `--x` is the value `x`
(`tw:bg-bg-raised`, `tw:text-text-2`, `tw:border-border`, `tw:bg-accent`;
[`tailwind.css`](src/tailwind.css)), so they follow the look. While there is a web half, the page
compiles its classes with the app's own; a class must appear whole in the
file, as Tailwind requires. A plugin's `styles` and the stylesheets in
`~/.lemma/plugins` are plain CSS: Tailwind's `@apply` does not reach them, and the
tokens do.

## Writing a plugin

[Writing plugins](../../docs/plugins.md) covers a plugin's two halves and the
shapes they meet the others in; this is the web half. A plugin requires and
provides capabilities, and adds items to slots.
The contracts declare them all: the runtime's in [`@lemma/web`](../../packages/web/src/index.ts), and each
domain's in its own package (`@lemma/frame`, `@lemma/threads`, `@lemma/look`, …; a web half gets them all
as `api.contracts`). The bundled plugins use nothing else:

- **Capabilities** are services with one provider, such as `Threads` or
  `Models`. The runtime's ([`@lemma/web`](../../packages/web/src/runtime.ts): `Client`,
  `Slots`, `Router`, `Notify`, `HostPlugins`, `Interactions`, `WebPlugins`, `PageTrace`)
  the app provides itself; every other comes from a plugin.
- **Slots** are places any number of plugins add to: regions of the screen,
  where the first item shows, and lists such as `Actions` (the
  palette and shortcuts) or `ComposerCompletions`. A plugin adds through the
  `Slots` its setup receives, and an item leaves when the plugin that added it
  stops.
- **Parts** are the pieces plugins draw with, such as `icon`, `dialog`, or
  `chat.tool`. Replace one everywhere by adding an item of your own: the
  bundled defaults are in the phase `default`, and an item that names no
  phase comes before them; `api.defaults` holds the bundled implementations. Some
  bundled parts declare a plain fallback, drawn while nothing provides them;
  a part from `api.definePart` has none, since its plugin provides it.

The devtools' Registries panel (`mod+shift+d`) lists every slot and who fills
it.

A web half needs no build step: its default export may be a function that
receives [the api](src/ui/api.ts), including Solid, the contracts,
`defineWebPlugin`, and `html` (Solid's JSX without a compiler).

```js
// ~/.lemma/plugins/tool-count.web.js
export default ({ defineWebPlugin, contracts: { Slots, Threads, SidebarFooter }, html }) =>
  defineWebPlugin({
    id: "tool-count",
    requires: { slots: Slots, threads: Threads },
    setup: ({ slots, threads }) => {
      const calls = () => threads.branch().filter((event) => event.data.type === "message" && event.data.message.role === "toolResult").length;
      slots.add(SidebarFooter, { id: "tool-count", order: 50, component: () => html`<span class="muted small">${calls} tool calls</span>` });
    },
  });
```

```js
// ~/.lemma/plugins/quiet-thoughts.web.js: thoughts as a single muted line
export default ({ defineWebPlugin, contracts: { Slots, ChatThinkingPart }, html }) =>
  defineWebPlugin({
    id: "quiet-thoughts",
    requires: { slots: Slots },
    setup: ({ slots }) => {
      slots.add(ChatThinkingPart, { id: "quiet", component: () => html`<p class="muted small">thought for a moment</p>` });
    },
  });
```

```js
// ~/.lemma/plugins/thread-links.web.js: `#` in the composer offers threads by title
export default ({ defineWebPlugin, contracts: { Slots, Threads, ComposerCompletions } }) =>
  defineWebPlugin({
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

`defineWebPlugin` is the kernel's promise-based `definePlugin`
([`@lemma/core/plain`](../../packages/core/README.md#plugins-written-with-promises))
with the page's conventions. `setup` runs in its own Solid root. What it adds to slots leaves when it stops,
and so does what it starts through its `plugin` handle: `plugin.listen(window, "resize", fn)`, `plugin.every(ms, fn)`,
`plugin.after(ms, fn)`, and `plugin.action(name, fn)` for an event handler, whose throw or rejection is then the
plugin's fault, named for it. A component it draws (its slot item, or the children it hands a part) reaches the same
handle with `usePlugin()`; a listener a component adds while it shows is removed with it too
(`onCleanup(plugin.listen(…))`). Release anything else it holds with `plugin.onCleanup`. Its `Client` is its own:
what it follows or subscribes to ends when it stops, and a call it made rejects with `PluginStopped` then, rather than
answer into a plugin that is gone. A
`config` Schema (from `api.Schema`, Effect 4's Schema with Effect 3's `Literal`,
`Record`, `between`, `positive`, `nonNegative`, `optionalWith`,
`propertySignature`, and `.annotations(…)`, so a file written for Effect 3 keeps
working) becomes the plugin's settings form. `styles` apply while it runs.
`api: 4` says which version of
the contracts it is written for (`contracts.WEB_API`), so a later incompatible
version leaves it out, saying so, rather than letting it fail at a call;
`routes` lists the routes it shows pages at, so their addresses name it while
it is off. Draw what a slot holds with `api.parts.Contained`, `Each`, or
`First`, so an item that throws fails alone. A file is one ES module: bundle
anything it imports, and take from the api what it offers, so it shares the
page's module instances. Web halves run with the page's permissions and token,
as host halves run with the host's.

`Client` is the page's connection to the host: its status, the host's own
calls and events (its plugins, inspectors, the rows), and the
[channels](../../packages/contracts/src/channels.ts) host plugins serve. Every
domain is reached through channels: the bundled plugins reach sessions,
the agent, models, the workspace, files, and commands that way, and a host
plugin serves its own web half the same way. A web plugin requires `Client` and calls
`client.channel.call(id, payload)`, or follows a stream with
`client.follow(id, payload, onElement, onEnd)`, which keeps it open: again on
every reconnect, at once when it ends `Withdrawn` (its plugin restarted), and
when a `channels-changed` event lists it after nothing served it, the policy
every client of the host shares (`follow` in `@lemma/client`). A
domain's stream starts with `subscribed`, from which its reader resyncs.
Passing a channel's declaration instead of its id (`api.channels` holds the
bundled domains', each domain's contract its own) types the call: the
payload and the results go through its schemas.
[`examples/ticker`](../../examples/ticker/README.md) is a folder plugin whose
host half serves prices and whose web half shows them at `/ticker`.

A replacement with a bundled plugin's id can wrap it rather than copy it, and
so keep what it gains in later versions: `api.bundled` holds the bundled
plugins, and `api.extendWebPlugin` makes a plugin from another's definition.
The runtime is not in `api.bundled`, and a plugin providing one of its
capabilities is left out: draw messages differently by replacing `frame.toasts`,
which decides how long each shows, rather than `Notify`.

```js
// ~/.lemma/plugins/toasts.web.js: the bundled toasts, logging each one too
export default ({ bundled, extendWebPlugin }) =>
  extendWebPlugin(bundled["frame.toasts"], (base) => ({
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
boot's `appRoutes`), and the plugins that show them list them in their
`routes` too, so a page whose plugin is off names it: a session's in
[`@lemma/sessions`](../../domains/sessions/contract/src/sessions.ts), shared with the
desktop app's `lemma://` links and `lemma open`, and settings' in
[`@lemma/settings`](../../domains/settings/contract/src/index.ts):

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
api.defineWebPlugin({
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

`mod+shift+d` docks the devtools under the app: routes, navigation, the
host's events (with, while the devtools are open, its domains' streams:
sessions' and commands' changes, models to list again, the agent's activity),
the channels host plugins serve, and, for the web app and the host alike,
plugins, hooks, registries, inspectors, and the trace (`devtools.trace`: every
span their plugins' work ends, as waterfalls, each plugin's time, the
composition's changes, and its faults). A capability the runtime provides
shows as the web app's or the host's, not as missing. They show the app as it
runs; the Plugins page is where things change. A web plugin adds a panel with
a `DevtoolsPanels` item, and a host plugin adds an inspector to the
`Inspectors` registry (`@lemma/contracts`), which also shows in
`lemma inspectors`.
