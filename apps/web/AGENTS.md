# Developing the web app

Everything the web app shows is a plugin, and every plugin is
**replaceable**: a user can turn it off, turn it on, configure it, or swap it
for their own, without editing this repository. The plugins are written
against the runtime (`src/runtime/`), which the boot provides and nothing
replaces: the connection, slots, the router, messages, the plugins, and
questions. The bundled plugins are defaults that sit on the same footing as a
user's UI file. Build every default so a user could have written it and could
replace it.

## Where each kind of code goes

- **A plugin** (`src/plugins/`) owns one part of the app. It declares what it
  `requires` and `provides`, adds to slots, draws, and brings its own
  stylesheet (`src/plugins/<id>.css`, passed as `styles`). One too large for a
  file is a directory, `src/plugins/<id>/`, with the plugin in `index.tsx`:
  its files import each other, and nothing outside it imports them. It imports
  only `ui/contracts`, `ui/define`, `ui/slots`, `ui/parts`, `model/`, `lib/`,
  and its own files.
- **A contract** (`src/ui/contracts.ts`) is how plugins meet: a capability (a
  service with one provider), a slot (a list or region many fill), a part, a
  shared id (`ActionIds`, `SectionIds`), or a DOM convention listed at the top
  of the file. When one plugin needs something from another, add it here.
- **The runtime** (`src/runtime/`, its contracts in `src/ui/runtime.ts`) is
  what every plugin is written against, the app's own: no plugin provides
  it, replaces it, or turns it off. It imports no plugin, component, or
  contract plugins provide, adds to no slot, and needs nothing a plugin
  contributes but reactively (the router with no pages matches nothing). It
  never throws into the page: a bad item from a plugin is that plugin's fault
  (`slots.fail`), and its own failures are logged and reported. Add to it
  only what no plugin could provide, since nothing can replace it.
- **A slot** is a core registry (`defineSlot`): an item belongs to the plugin
  that added it, leaves when that plugin stops, and shows on the Plugins page.
- **A part** is a replaceable piece plugins draw with (`definePart`): the first
  item by order in its slot renders wherever the part is used. Draw shared
  pieces through `ui/parts.tsx`; `kit` supplies the shared parts' defaults and
  is the only plugin that imports `components/`. A view that has pieces users
  would change on their own (a tool call, a row) defines parts for them and
  adds its own defaults at `DEFAULT_PART_ORDER`, as `chat` does. A part may
  declare a plain fallback (`definePart(name, fallback)`): native markup with
  no styling of its own, used while nothing provides the part. The parts the
  always-on plugins draw (`shell`, `pages`, `settings`, `plugins-page`) have
  one, in `ui/fallbacks.tsx`, so with `kit` off the Plugins page still works;
  give one to any part they start to draw (`tests/ui.test.ts` fails until
  you do).
- **A component** (`src/components/`) is a default implementation of a part.
  It draws other parts through `ui/parts.tsx`.
- **A model** (`src/model/`) is pure data and functions, tested in `tests/`.
- **The foundation** (`src/styles.css`) holds the tokens, base styles, and
  the class vocabulary several plugins share (`.button`, `.field`,
  `.menu-*`). A rule one plugin's markup needs goes in that plugin's
  stylesheet, or is Tailwind utilities in its markup.
- **The look is tokens all through**, so a theme or a setting reaches every
  plugin. Draw with the foundation's tokens; a color of a plugin's own (a
  shadow, a palette) is a token declared in its stylesheet, its default the
  look it has. Sizes are scaled: `calc(12px * var(--text-scale))` for a font,
  `calc(6px * var(--radius-scale))` for a corner. In a stylesheet,
  `check-boundaries` fails a color written outside a token's declaration, or
  a font size, line height, or radius with px not scaled so.
- **Utilities** (`src/tailwind.css`) are Tailwind's, prefixed `tw:` and named
  for the tokens: the token `--x` is the value `x`, as in `tw:bg-bg-raised`
  and `tw:text-text-2`. Use them for a plugin's own layout and spacing, as
  `appearance-page` does. A piece other plugins draw, or a user would restyle
  across the app, keeps a semantic class and a part, so one rule in a
  stylesheet restyles it everywhere. Write a class whole (`tw:bg-accent`,
  never `tw:bg-${name}`): the build finds classes by reading the source.

## Adding or changing UI

1. Decide which plugin owns it. New state other plugins read goes behind a
   capability; a place others add to is a slot (a list: buttons, tabs, palette
   sources); a piece others would restyle or rework is a part.
2. Build the default through the extension point it offers: a view's own
   buttons, tabs, and rows go through the same slot or part a user's plugin
   would use, as the sidebar's buttons and the palette's sources do.
3. Keep the plugin's effects inside what it owns: its slot items, its parts,
   its own DOM (through refs), its stylesheet. Draw what a slot holds with
   `Contained`, `Each`, or `First` from `ui/parts.tsx`, never a bare
   `Dynamic`: an item that throws then fails alone, named for its plugin, and
   a region shows its next item. A component handed over as data (a
   completion's icon) draws with `Isolated`. Overlays are `Layers` items drawn
   with the `dialog` part; app-wide keys are `Actions`, and an overlay handles
   its own keys on its own element; the page's theme goes through
   `lib/paint.ts`; what covers the page stacks by the `--z-*` tokens.
4. Make it a plugin of its own only when someone would turn it off or replace
   it on its own (`highlight`, `palette`); when it is a model other plugins
   need beside a view a user might drop, which is then two plugins (`models`
   and `model-picker`); or when what it requires can be missing while the rest
   still works. Size, tidiness, or being one more panel, tab, or section is no
   reason: those are files in a plugin's directory and items one plugin adds to
   a slot, as the devtools add their panels.
5. Document new contracts where they are declared: `ui/contracts.ts` is the
   list of slots and parts that users and the devtools read.

Done means these pass:

```sh
nix develop -c node scripts/check-boundaries.ts             # imports, page-wide DOM and keys, stacking (also in `pnpm check`)
nix develop .#browser -c pnpm --filter @lemma/web ui:check  # the real composition in Chromium, against the mock host
```

`ui:check` boots the app and fails when a part has no provider, a plugin cannot
turn off and on without errors or leaves its stylesheet behind, more than the
pinned plugins and what they need stay on, the runtime stops answering with
every plugin off, a UI file providing part of the runtime is not left out, a
replaced part does not show, or an extension slot does not render what a
plugin adds. What it adds to slots it adds through a UI file's plugin
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
