# frame.shell

The page's frame: the sidebar region beside the main region, the layers over
them, and the docks under them. Adds the frame to `Root` (the runtime's slot,
in [`@lemma/web`](../../../packages/web/src/runtime.ts)). The frame draws the
first item of `SidebarRegion` and of `MainRegion`, every `Layers` item, and
every `Docks` item ([`@lemma/frame`](../contract/src/index.ts)). Provides
`Layout`. Adds `shell.toggle-sidebar` (`mod+b`) and `shell.close-drawer`
(Escape, while the drawer is open) to `Actions`. No config.

It is pinned: replace it with a web half of your own under its id, but never
turn it off, since every view shows in it, the Plugins page included.

## Behavior

- **The shell sizes the sidebar.** Whatever fills `SidebarRegion` only fills
  it. Drag its edge, or press ← and → while the edge has focus, for 208 to
  400px. A double-click or Enter resets it to 264px. The main region keeps
  560px where the window allows.
- **A narrow window** (up to 820px) shows the sidebar as a drawer over the
  page. `Layout.toggleSidebar` opens it, and `onPick`, Escape, or a click
  beside it closes it. While it is open, the page beside it is inert.
- **Kept in this browser:** `lemma.sidebar.width` holds the chosen width and
  `lemma.sidebar.collapsed` whether the sidebar is collapsed. A narrower
  window clamps the width shown, not the one chosen.
- **Focus stays put.** When a toggle hides the control that had focus, focus
  goes to the toggle in sight: a control marked `data-sidebar-toggle`
  (`Layout`).
- **An empty `SidebarRegion`** gives the main region the whole width.
- **In a desktop window** whose controls overlay the page, it sets
  `data-titlebar` on `.app`, and `--titlebar-inset` and `--titlebar-inset-end`
  on the columns under them. Other plugins' stylesheets read them, as
  [`@lemma/web`](../../../packages/web/src/index.ts) describes.

## Rationale

- **A replacement** adds to `Root`, provides `Layout`, and draws all four
  slots: the dialogs, questions, toasts, and tooltips are `Layers` items, and
  the devtools a `Docks` item. If the frame fails to draw, the page says so
  and links to `?safe`, which runs the app as shipped.
