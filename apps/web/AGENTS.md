# Developing the web app

Every piece of the web app is **replaceable**: a user can turn it off, turn it
on, configure it, or swap it for their own, without editing this repository.
The bundled plugins are defaults that sit on the same footing as a user's UI
file. Build every default so a user could have written it and could replace it.

## Where each kind of code goes

- **A plugin** (`src/plugins/`) owns one part of the app. It declares what it
  `requires` and `provides`, adds to slots, draws, and brings its own
  stylesheet (`src/plugins/<id>.css`, passed as `styles`). It imports only
  `ui/contracts`, `ui/define`, `ui/slots`, `ui/parts`, `model/`, `lib/`, and
  its own stylesheet.
- **A contract** (`src/ui/contracts.ts`) is how plugins meet: a capability (a
  service with one provider), a slot (a list or region many fill), a part, a
  shared id (`ActionIds`, `SectionIds`), or a DOM convention listed at the top
  of the file. When one plugin needs something from another, add it here.
- **A slot** is a core registry (`defineSlot`): an item belongs to the plugin
  that added it, leaves when that plugin stops, and shows on the Plugins page.
- **A part** is a replaceable piece plugins draw with (`definePart`): the first
  item by order in its slot renders wherever the part is used. Draw shared
  pieces through `ui/parts.tsx`; `kit` supplies the shared parts' defaults and
  is the only plugin that imports `components/`. A view that has pieces users
  would change on their own (a tool call, a row) defines parts for them and
  adds its own defaults at `DEFAULT_PART_ORDER`, as `chat` does.
- **A component** (`src/components/`) is a default implementation of a part.
  It draws other parts through `ui/parts.tsx`.
- **A model** (`src/model/`) is pure data and functions, tested in `tests/`.
- **The foundation** (`src/styles.css`) holds the tokens, base styles, and the
  class vocabulary several plugins share (`.button`, `.field`, `.menu-*`). A
  rule one plugin's markup needs goes in that plugin's stylesheet.

## Adding or changing UI

1. Decide which plugin owns it. New state other plugins read goes behind a
   capability; a place others add to is a slot (a list: buttons, tabs, palette
   sources); a piece others would restyle or rework is a part.
2. Build the default through the extension point it offers: a view's own
   buttons, tabs, and rows go through the same slot or part a user's plugin
   would use, as the sidebar's buttons and the palette's sources do.
3. Keep the plugin's effects inside what it owns: its slot items, its parts,
   its own DOM (through refs), its stylesheet. Overlays are `Layers` items drawn
   with the `dialog` part; app-wide keys are `Actions`, and an overlay handles
   its own keys on its own element; the page's theme goes through
   `lib/paint.ts`; what covers the page stacks by the `--z-*` tokens.
4. A plugin whose model other plugins need, and whose view a user might turn
   off, is two plugins: the model (as `notify`) and the view (as `toasts`).
5. Document new contracts where they are declared: `ui/contracts.ts` is the
   list of slots and parts that users and the devtools read.

Done means these pass:

```sh
nix develop -c node scripts/check-boundaries.ts             # imports, page-wide DOM and keys, stacking (also in `pnpm check`)
nix develop .#browser -c pnpm --filter @lemma/web ui:check  # the real composition in Chromium, against the mock host
```

`ui:check` boots the app and fails when a part has no provider, a plugin cannot
turn off and on without errors or leaves its stylesheet behind, a replaced part
does not show, or an extension slot does not render what a plugin adds.

For a change to how things look, compare screenshots of the main screens:

```sh
nix develop .#browser -c node scripts/shots.ts /tmp/shots/before   # before the change
nix develop .#browser -c node scripts/shots.ts /tmp/shots/after    # after it
nix develop .#browser -c node scripts/compare-shots.ts /tmp/shots/before /tmp/shots/after
```

The Plugins page shows the dev server's port and the chat a turn's duration, so
those differ between runs by a hundredth of a percent.
