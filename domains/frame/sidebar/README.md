# frame.sidebar

The threads list: pinned threads first, then the rest by project, with a
search over their titles, a menu for each thread and project, and buttons in
its head. Adds it to `SidebarRegion`, where it draws `SidebarActions` beside
its search and `SidebarFooter` at its foot
([`@lemma/frame`](../contract/src/index.ts)). Each thread is a
`SidebarRowPart` and its menu the `ThreadActions`
([`@lemma/threads`](../../threads/contract/src/index.ts)); a project's menu is
the `ProjectActions`
([`@lemma/workspace/web`](../../workspace/contract/src/web/index.ts)). Requires
`Threads`, `Workspace`, `Client`, `Notify`, `Slots`, and `WebPlugins`. No
config.

Its own items go through the slots a user's plugin adds to, so another
plugin's sit among them by `order`:

| Slot             | Its items, by `order`                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SidebarRegion`  | `sidebar` 0                                                                                                                              |
| `SidebarActions` | `sidebar.palette` 0, `sidebar.projects` 10, `sidebar.add-project` 20, `sidebar.new-chat` 30                                              |
| `ThreadActions`  | `sidebar.rename` 10, `sidebar.pin` 20, `sidebar.archive` 30, `sidebar.delete` 40                                                         |
| `ProjectActions` | `sidebar.new-chat` 10, `sidebar.copy-path` 20                                                                                            |
| `SidebarRowPart` | `sidebar.row` at `DEFAULT_PART_ORDER`                                                                                                    |
| `Actions`        | `sidebar.next-thread` 20, `sidebar.previous-thread` 21, `sidebar.pin-thread` 23, `sidebar.archive-thread` 24, `sidebar.delete-thread` 25 |

## Behavior

- **What it lists.** Archived threads are not listed (`fileSessions` in
  `@lemma/threads`), and the list says so when every thread is archived.
  Threads in no project (`Workspace.isStandalone`) are a "No project" section,
  whose new-thread button starts another in no project and which has no
  project menu.
- **Folded sections** stay folded across reloads, kept in this browser
  (`lemma.sidebar.folded`; whether the whole sidebar is collapsed is
  `frame.shell`'s).
- **Search** matches titles, ignoring case, and opens every folded section
  while it runs; Escape clears it.
- **The projects button** (`sidebar.projects`) narrows the list to one
  project's threads, for the page's life; a project that loses its last thread
  lets go.
- **Buttons for other plugins' actions.** The palette and add-project buttons
  run the `Actions` items `ActionIds.palette` and
  `WorkspaceActionIds.addProject`, and show only while one is there, so a
  plugin replacing either keeps its button.
- **The default row** shows the title, a dot while a turn runs, and the time,
  which gives way to the menu's button on hover; a double-click renames the
  thread, and a right-click opens its menu.
- **Keys.** Next and previous thread (`mod+alt+arrowdown`, `mod+alt+arrowup`)
  go through the threads in the sidebar's order, wrapping, whatever the search
  or project shows. Pin or unpin (`mod+alt+p`), archive (`mod+alt+a`), and
  delete (no key) act on the open thread. Settings › Keyboard rebinds them.
