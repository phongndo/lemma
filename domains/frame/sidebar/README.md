# frame.sidebar

Every thread down the side, in `SidebarRegion`: drafts on top, then the pinned
and active threads in an order dragged into, then the archived, folded away.
Its head adds defaults to `SidebarActions`
([`@lemma/frame`](../contract/src/index.ts)): the command palette
(`ActionIds.palette`) and Search (`ActionIds.searchThreads`), each while a
plugin offers it, and New thread. Its foot has the `SidebarFooter`. Each thread
is a `SidebarRowPart`, and its menu is `ThreadActions`
([`@lemma/threads`](../../threads/contract/src/index.ts)).

## Behavior

- **Order.** Drafts (`Threads.drafts`) come newest first. A newly pinned
  thread goes on top of the pinned, and a new thread on top of the active. A
  running thread does not move. A thread with nothing sent and nothing written
  is not listed. Archived threads come latest archived first.
- **Agents** a thread started with `delegate` (`SessionInfo.parent`) are
  listed under it while neither is archived. An agent archived apart, or whose
  thread is gone or archived, is listed as a thread of its own.
- **A card's state** is the most pressing one (`Threads.attention`):
  `Needs input`, `Working`, `Failed` or `Out of steps`, `Done` once a turn
  ended unseen, else how long ago the thread was used. A thread in a worktree
  is listed under its repository's project (`Workspace.place`).
- **Dragging** a thread among the pinned pins it there, among the active
  unpins it there, and onto the archived panel archives it. Drafts and
  archived threads do not drag.
- **Archiving** the thread shown goes on to the next in the list. A running
  thread can be archived, and its turn goes on.
- **Keys.** `mod+1` … `mod+9` go to the thread at that place, pinned ones
  first; holding `mod` shows each thread's key (`Action.onHold`). `mod+alt+a`
  archives or unarchives the thread shown. In the desktop app, `mod+shift+]`
  and `mod+shift+[` go to the next and previous thread; a browser keeps those
  keys for its tabs, so there they are the palette's Next thread and Previous
  thread. `alt+shift+arrowdown` and `alt+shift+arrowup` go round the threads
  that need you: one that waits on you, or is `Done` or `Failed`. A
  double-click renames a thread, and a right-click opens its menu. Settings ›
  Keyboard rebinds them all.
- **Kept in this browser:** `lemma.frame.sidebar.marks` holds the pinned and
  active orders, and when threads were archived and unarchived.
  `lemma.frame.sidebar.archived-open` and `lemma.frame.sidebar.archived-height`
  hold the archived panel's fold and height.
