# Developing the web app

Everything the web app shows is a plugin, and every plugin is
**replaceable**: a user can turn it off, turn it on, configure it, or swap it
for their own, without editing this repository. The plugins are written
against the runtime, which the boot provides (`src/runtime/`) and nothing
replaces: the connection, slots, the router, messages, the plugins, and
questions. The bundled plugins are defaults that sit on the same footing as a
user's web half. Build every default so a user could have written it and could
replace it.

## Where each kind of code goes

- **A plugin** is a package in its domain's folder, `domains/<domain>/<name>`,
  with the id `<domain>.<name>` (`frame.shell`, `threads.transcript`). It
  declares what it `requires` and `provides`, adds to slots, draws, and brings
  its own stylesheet (`src/<name>.css?inline`, passed as `styles`). Its files
  import each other, and nothing outside it imports them. It imports only
  `@lemma/web` (the plugin API), contracts (`@lemma/<domain>`, and a host
  domain's web contract, `@lemma/<domain>/web`), and npm packages: never
  another plugin (`check-boundaries` fails it). `apps/web/src/bundled.ts`
  lists the bundled ones, and `ui:check` fails unless it lists every web half
  the domains' `lemma` manifests name. A host plugin's web half lives in its
  package (`src/web.ts`, exported as `./web`), with its id, as the tools' do.
- **A contract** is how plugins meet: a capability (a service with one
  provider), a slot (a list or region many fill), a part, a shared id
  (`SectionIds`, `ActionIds`), or a DOM convention (listed in `@lemma/web`'s
  index). Each lives in its domain's contract package: `@lemma/frame` (the
  regions, layers, layout, dialogs), `@lemma/look` (themes, fonts, the shared
  parts), `@lemma/settings`, `@lemma/actions`, `@lemma/threads`, and the web
  halves of host domains (`@lemma/llm/web`, `@lemma/workspace/web`,
  `@lemma/commands/web`, `@lemma/devtools/web`). When one plugin needs
  something from another, add it to the contract of the domain that owns it.
  What two plugins of a domain share (a projection, a model) goes in its
  contract too, as the threads contract's transcript does.
- **The runtime** (`src/runtime/`, its contracts in `@lemma/web`) is what
  every plugin is written against, the app's own: no plugin provides it,
  replaces it, or turns it off. It imports no plugin or domain contract, adds
  to no slot, and needs nothing a plugin contributes but reactively (the
  router with no pages matches nothing). It never throws into the page: a bad
  item from a plugin is that plugin's fault (`slots.fail`), and its own
  failures are logged and reported. Add to it only what no plugin could
  provide, since nothing can replace it.
- **`@lemma/web`** (`packages/web`) is the plugin API: the runtime's contracts,
  `defineWebPlugin`, slots and parts (`defineSlot`, `definePart`, `partView`),
  drawing what slots hold (`Contained`, `Each`, `First`, `Isolated`), and
  helpers any plugin may use (`/keys`, `/storage`, `/now`, `/clipboard`,
  `/quick-pick`, `/paint`, `/match`, `/format`, `/drag`). It is part of the runtime:
  it reaches no domain.
- **A slot** is a core registry (`defineSlot`): an item belongs to the plugin
  that added it, leaves when that plugin stops, and shows on the Plugins page.
  Items of equal `order` sort by plugin id: give an item whose place matters
  an `order` of its own (the views of a thread, the layers). Where the order
  means something beyond a position (a default and what replaces it), the slot
  declares phases (`defineSlot(name, { phases, defaultPhase })`), and its first
  declaration fixes them and what shows.
- **A part** is a replaceable piece plugins draw with (`definePart`), declared
  in a contract beside its view (`partView(part)`, which plugins draw): the
  first item in its slot renders wherever the part is used.
  `look.kit` supplies the shared parts' defaults (`@lemma/look`), and is the
  only plugin with rendering components of that kind. A view that has pieces
  users would change on their own (a tool call, a row) defines parts for them
  in its domain's contract and adds its own defaults in the phase `default`
  (`FIRST_WINS`, which every slot that shows one item has), as
  `threads.transcript` does, so an item of a user's that names no phase
  replaces them. A part may declare a plain fallback
  (`definePart(name, fallback)`): native markup with no styling of its own,
  used while nothing provides the part. The parts the always-on plugins draw
  (`frame.shell`, `frame.pages`, `settings.page`, `settings.plugins`) have
  one, in `@lemma/look`'s `fallbacks.tsx`, so with `look.kit` off the Plugins
  page still works; give one to any part they start to draw
  (`tests/ui.test.ts` fails until you do).
- **A model** is pure data and functions: in the plugin that uses it, or in
  its domain's contract when two plugins share it. Test it in its package's
  `tests/` (`vitest.config.ts` default-exports `@lemma/web/vitest`).
- **The foundation** (`src/styles.css`) holds the tokens, base styles, and
  the class vocabulary several plugins share (`.button`, `.field`,
  `.menu-*`). A rule one plugin's markup needs goes in that plugin's
  stylesheet, or is Tailwind utilities in its markup.
- **The look is tokens all through**, so a theme or a setting reaches every
  plugin. Draw with the foundation's tokens; a color of a plugin's own (a
  shadow, a palette) is a token declared in its stylesheet, its default the
  look it has. A font size is scaled, `calc(12px * var(--text-scale))`, and a corner is
  one of the foundation's `--radius-*` tokens, chosen by what it rounds (they
  are listed with their roles in `src/styles.css`). A shape inside another,
  near its edge, takes the outer radius less the gap; shapes that touch are one
  shape. In a stylesheet, `check-boundaries` fails a color written outside a
  token's declaration, a font size or line height in px not scaled so, or a
  radius that is not a `--radius-*` token, `50%`, `0`, or `inherit`.
- **Utilities** (`src/tailwind.css`) are Tailwind's, prefixed `tw:` and named
  for the tokens: the token `--x` is the value `x`, as in `tw:bg-bg-raised`
  and `tw:text-text-2`. Use them for a plugin's own layout and spacing, as
  `look.appearance-page` does. A piece other plugins draw, or a user would
  restyle across the app, keeps a semantic class and a part, so one rule in a
  stylesheet restyles it everywhere. Write a class whole (`tw:bg-accent`,
  never `tw:bg-${name}`): the build finds classes by reading the source
  (`src/`, `domains/`, and `packages/web`).

## Adding or changing UI

1. Decide which plugin owns it. New state other plugins read goes behind a
   capability; a place others add to is a slot (a list: buttons, tabs, palette
   sources); a piece others would restyle or rework is a part.
2. Build the default through the extension point it offers: a view's own
   buttons, tabs, and rows go through the same slot or part a user's plugin
   would use, as the sidebar's buttons and the palette's sources do.
3. Keep the plugin's effects inside what it owns: its slot items, its parts,
   its own DOM (through refs), its stylesheet. What it starts beyond them goes
   through its handle (`plugin` in setup, `usePlugin()` in a component it
   draws): `listen` for the page's events, `every` and `after` for timers,
   `action` for an event handler that returns a promise, so each ends with it
   and fails as its fault (`check-boundaries` fails a page-wide
   `addEventListener`, a `setInterval`, or a handler that drops a promise).
   Draw what a slot holds with `Contained`, `Each`, or `First` from
   `@lemma/web`, never a bare `Dynamic`: an item that throws then fails alone,
   named for its plugin, and a region shows its next item. A component handed over as data (a
   completion's icon) draws with `Isolated`. Overlays are `Layers` items drawn
   with the `dialog` part; app-wide keys are `Actions`, and an overlay handles
   its own keys on its own element; the page's theme goes through
   `@lemma/web/paint`; what covers the page stacks by the `--z-*` tokens.
4. Make it a plugin of its own only when someone would turn it off or replace
   it on its own (`look.highlight`, `actions.palette`); when it is a model other
   plugins need beside a view a user might drop, which is then two plugins
   (`llm.client` and `llm.model-picker`); or when what it requires can be missing while the rest
   still works. Size, tidiness, or being one more panel, tab, or section is no
   reason: those are files in a plugin's package and items one plugin adds to
   a slot, as the devtools add their panels. A new plugin is a package in the
   domain it serves (`domains/<domain>/<name>`), added to `src/bundled.ts`.
5. Document new contracts where they are declared: the contracts are the list
   of slots and parts that users and the devtools read.

Done means these pass:

```sh
nix develop -c node scripts/check-boundaries.ts             # imports, page-wide DOM and keys, stacking (also in `pnpm check`)
nix develop .#browser -c pnpm --filter @lemma/web-app ui:check  # the real composition in Chromium, against the mock host
```

`ui:check` boots the app and fails when a part has no provider, a plugin cannot
turn off and on without errors or leaves its stylesheet behind, more than the
pinned plugins and what they need stay on, the runtime stops answering with
every plugin off, a web half providing part of the runtime is not left out, a
replaced part does not show, or an extension slot does not render what a
plugin adds. What it adds to slots it adds through a web half
(`check`), as a user's code does.

For a change to how things look, compare screenshots of the main screens:

```sh
nix develop .#browser -c node apps/web/scripts/shots.ts /tmp/shots/before   # before the change
nix develop .#browser -c node apps/web/scripts/shots.ts /tmp/shots/after    # after it
nix develop .#browser -c node apps/web/scripts/compare-shots.ts /tmp/shots/before /tmp/shots/after
```

A few screens show what changes from run to run: the Plugins page the dev
server's port, the devtools' Navigation and Host events panels their times and
keys, and the trajectory a turn's timings. Those differ between runs by up to
about a quarter of a percent; every other screen matches exactly.
