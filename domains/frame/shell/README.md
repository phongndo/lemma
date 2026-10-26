# frame.shell

The page's frame: the sidebar region beside the main region, the layers over
them, and the docks under them. Adds the frame to `Root` (the runtime's slot,
in [`@lemma/web`](../../../packages/web/src/runtime.ts)), which draws the first
item of `SidebarRegion` and of `MainRegion`, every `Layers` item, and every
`Docks` item ([`@lemma/frame`](../contract/src/index.ts)). Provides `Layout`,
and adds `shell.toggle-sidebar` (`mod+b`) and `shell.close-drawer` (Escape,
while the drawer is open) to `Actions`. Requires `Slots`. Pinned: replace it
with a web half of your own with its id, never turn it off, since every view
shows in it, the Plugins page where plugins are turned back on included. No
config.

## Behavior

- **The sidebar's box is the shell's.** Whatever fills `SidebarRegion` only
  fills it: the shell sizes it (drag its edge, or ← and → by 16px while the
  edge has focus, from 208 to 400px, leaving the main region 560px where the
  window allows; a double-click or Enter resets it to 264px) and collapses it. On a window up to 820px wide it is a drawer over the
  page instead, as wide as chosen up to the window's width less 48px, which
  `toggleSidebar` opens and `onPick`, Escape, or a click beside it closes.
  While it is open the page beside it and the docks are inert and focus is in
  it (and in what shows over it, a toast or a notice); closed, it gives focus
  back to what had it, and is inert itself. The chosen width and
  whether it is collapsed are kept in the browser's storage; a narrower window
  clamps the width shown, not the one chosen.
- **Focus stays put.** When toggling, or the window narrowing or widening,
  hides the control that had focus (the sidebar's own toggle as it collapses,
  anything in it as it becomes a closed drawer, a header's toggle as it comes
  back), focus goes to the toggle in sight, a control marked
  `data-sidebar-toggle` ([`@lemma/frame`](../contract/src/index.ts)'s `Layout`).
- **An empty region.** With nothing in `SidebarRegion`, the main region takes
  the whole width.
- **A desktop window.** While the window's own controls overlay the page
  (Window Controls Overlay), it sets `data-titlebar` on `.app`, and
  `--titlebar-inset` and `--titlebar-inset-end` on the columns under them, the
  DOM convention [`@lemma/web`](../../../packages/web/src/index.ts) describes,
  which other plugins' stylesheets read. On Windows and Linux it gives the
  controls the page's background and muted text (`lemmaDesktop.titleBar`),
  again whenever the look changes.

## Rationale

- **A replacement** adds to `Root`, provides `Layout`, and draws all four
  slots: the dialogs, questions, toasts, and tooltips are `Layers` items, and
  the devtools a `Docks` item. If the frame fails to draw, the page says so
  and links to `?safe`, which runs the app as shipped.
