# frame

The page's frame: its regions, layers, docks, dialogs, and what shows in them before any view. Its contract is [`@lemma/frame`](contract/src/index.ts).

| Plugin                            | Halves | What it does                                                                                                                                        |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`frame.shell`](shell/)           | web    | The top bar, sidebar, and main regions, layers over them, and docks under them. Pinned: replace it, never turn it off                               |
| [`frame.pages`](pages/)           | web    | The page the address names, in the main region; `mod+[` and `mod+]` go back and forward. Pinned                                                     |
| [`frame.threads`](threads/)       | web    | Every thread as a tab: down the side (the default) or across the top; drafts first, then pinned and active in an order dragged into, archived apart |
| [`frame.dialogs`](dialogs/)       | web    | Which dialog is open: provides `Dialogs`                                                                                                            |
| [`frame.questions`](questions/)   | web    | The host's questions, the oldest first                                                                                                              |
| [`frame.toasts`](toasts/)         | web    | The `Notify` messages, in a corner                                                                                                                  |
| [`frame.tooltips`](tooltips/)     | web    | Tooltips for elements marked `data-tip`                                                                                                             |
| [`frame.connection`](connection/) | web    | How the connection to the host is doing                                                                                                             |
| [`frame.reload`](reload/)         | web    | Loads what changed without leaving the app                                                                                                          |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                        |
| --------- | ------------------------------------------------------------------------------- |
| Add       | `Layers` (what covers the page), `Docks`, `SidebarActions`, `SidebarFooter`     |
| Intercept | `MainRegion`, `SidebarRegion`, and `TopRegion`: the first item draws the region |
| Observe   | `Layout`'s signals                                                              |
| Call      | `Dialogs`, `Layout`                                                             |
| Serve     | `Dialogs`, `Layout`: a plugin providing one replaces the frame's                |
