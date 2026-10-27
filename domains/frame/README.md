# frame

The page's frame: its regions, layers, docks, dialogs, and what shows in them before any view. Its contract is [`@lemma/frame`](contract/src/index.ts).

| Plugin                            | Halves | What it does                                                                                                                                                       |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`frame.shell`](shell/)           | web    | The top bar, sidebar, and main regions, layers over them, and docks under them. Pinned: replace it, never turn it off                                              |
| [`frame.pages`](pages/)           | web    | The page the address names, in the main region; Go back and Go forward, on ⌘[ and ⌘] (Alt+← and Alt+→ off macOS) in the desktop app (a browser keeps them). Pinned |
| [`frame.sidebar`](sidebar/)       | web    | Every thread down the side, each a card: drafts on top, pinned and active in an order dragged into, archived below                                                 |
| [`frame.dialogs`](dialogs/)       | web    | Which dialog is open: provides `Dialogs`                                                                                                                           |
| [`frame.questions`](questions/)   | web    | The host's questions, the oldest first, and the threads they wait in (`ThreadWaits`: `Needs approval`, or `Needs input` for a value)                               |
| [`frame.toasts`](toasts/)         | web    | The `Notify` messages, in a corner                                                                                                                                 |
| [`frame.tooltips`](tooltips/)     | web    | Tooltips for elements marked `data-tip`                                                                                                                            |
| [`frame.connection`](connection/) | web    | How the connection to the host is doing                                                                                                                            |
| [`frame.reload`](reload/)         | web    | Loads what changed without leaving the app                                                                                                                         |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                    |
| --------- | --------------------------------------------------------------------------- |
| Add       | `Layers` (what covers the page), `Docks`, `SidebarActions`, `SidebarFooter` |
| Intercept | `MainRegion` and `SidebarRegion`: the first item draws the region           |
| Observe   | `Layout`'s signals                                                          |
| Call      | `Dialogs`, `Layout`                                                         |
| Serve     | `Dialogs`, `Layout`: a plugin providing one replaces the frame's            |
