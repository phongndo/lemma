# frame.sidebar

Every thread down the side (in `SidebarRegion`): new threads left mid-prompt
on top, then the pinned and the active ones in an order dragged into, and the
archived folded away below. Its head has the toggle, and across from it the
`SidebarActions` ([`@lemma/frame`](../contract/src/index.ts)), whose defaults
it adds: the command palette (`ActionIds.palette`) and Search, which opens
the palette's thread search (`ActionIds.searchThreads`), each while a plugin
offers it, and New thread. Its foot
has the `SidebarFooter`. Each thread is a `SidebarRowPart` and its menu the
`ThreadActions` ([`@lemma/threads`](../../threads/contract/src/index.ts)).
Requires `Threads`, `Slots`, `WebPlugins`, `Layout`, and `Workspace`.

## Behavior

- **Drafts.** A new thread with a prompt written in it and not sent
  (`Threads.drafts`) is held on top, newest first, tinted: the prompt's first
  line and its project. Opening one keeps it there while it shows; under the
  pointer, Discard deletes it. The thread shown is not among them unless it was
  one when opened, and a thread with nothing sent and nothing written is not
  listed. A listed thread with a prompt unsent in it (not the one shown) is
  tinted and marked with a pen.
- **Agents** (sessions a thread started with `delegate`, `SessionInfo.parent`)
  are listed under the thread that started them, not on their own, while it is
  there and neither is archived, and an agent's own agents under it, stepped
  in, below the same thread: a line of how many, open while one works or
  waits on the person, or it or one of them is shown, unless folded; each a
  slim row of its picture (`AvatarPart`), its title, and its state, which
  opens it. One archived apart, or whose thread is gone or archived, is a
  thread of its own.
- **Pinned threads** come first, in the order they were dragged into; a thread
  newly pinned, here or elsewhere (its menu, `mod+alt+p`), goes on top of them.
- **Active threads** follow: new and unarchived ones on top, newest first,
  above those dragged into an order. A running thread does not move.
- **Archived threads** are in a panel of their own at the sidebar's foot,
  folded away, their count on the fold. The panel is there with none archived
  too, so archiving a thread leaves the fold as it was. Opened, it is as tall
  as its rows, up to a height its top edge sets: dragged, with ↑ and ↓ while
  focused, or back to its first with a double-click; past it, its rows scroll
  apart from the list above. A height past its rows, which would show nothing
  more until more are archived, is not kept. The height is kept, and the list above always
  keeps some room. With no thread above it (a first run), the list says so,
  and which keys start one. Every archived thread is
  there, the latest archived first. The open thread shows even while the fold
  is closed.
- **A card** is two lines of one height each, so nothing it shows, or the
  pointer, changes its size. The first is its title alone, which nothing cuts
  short; a title too long fades out. The second is its project and the branch
  its folder has checked out (`Workspace.place`: a thread in a worktree is
  under its repository's project, its branch marked as a worktree's), then at its end its state, the most pressing first, as T3 Code
  shows it (`Threads.attention`): what it waits on the person for
  (`Needs input`), `Working` and how long while a turn runs, `Failed` (or
  `Out of steps`) or `Done` once one ended unseen, else how long ago it was
  used. An archived thread is one slim line.
- **Under the pointer**, or while the keyboard is in it (Tab goes on from its
  link to them), a card's state gives way to buttons to pin it (or
  unpin it) and to archive it, and an archived row's age to Unarchive;
  `mod+alt+a` archives the thread shown, or unarchives it. Archiving the thread
  shown goes on to the next in the list. A running thread archives too: its turn goes on, and
  its archived row says what it is doing (`Working`, `Needs input`, `Done`)
  where its age goes.
- **Dragging.** A thread dragged up and down the list goes where it is
  dropped: among the pinned it is pinned there, among the active it is unpinned
  there (and the active ones keep that order), and onto the archived panel it
  is archived, first of them. While it is dragged, it is ringed in the accent,
  the sections are named over a rule, the name of the one it is in taking the
  accent (an empty section is its name alone: dragged over it, the thread goes
  in), the panel lights while it is over it and offers a place to drop while
  folded, and the thread says what dropping it there does (Pin, Unpin,
  Archive). Only the
  pointer moves it, so the names appearing under a still pointer move nothing.
  Drafts and archived threads do not drag: one comes back with Unarchive.
- **Details.** A moment's pointing at a card shows its title, project, branch,
  and state beside the sidebar; the next card pointed at shows its own at
  once. Only the pointer moving shows them, not a card moving under a still
  pointer (a thread made or archived above it), and a key press puts them away.
- **Focus stays in the list.** Archiving, deleting, or discarding the row that
  has focus moves it to the next row (the one before, at the end; with none,
  New thread); a row that moves (pinned) keeps it.
- **Search** is the palette's, floating over the page: threads by title,
  project, and what was said in them.
- **Keys.** `mod+1` … `mod+9` go to the thread at that place, pinned ones
  first; while `mod` is held alone a moment (`Action.onHold`, from the
  keymap), each of those threads shows its keys (`⌘1`) where its state goes,
  as T3 Code does, unless a list that picks with them has it (the composer's
  completions). In the desktop app, `mod+shift+]` and `mod+shift+[` go to the
  next and previous, stopping at the ends; a browser keeps them for its tabs,
  so there Next thread and Previous thread are the palette's.
  `alt+shift+arrowdown` and `alt+shift+arrowup` go to the next and previous
  thread that needs you, round
  the list, as Slack and Discord step through what is unread: one that waits
  on you or is `Done` or `Failed`, or an agent under one that waits on you
  (a finished agent's thread goes on with what it did). In a text field they
  stay its own (on macOS, selecting to a paragraph's end). A right-click opens
  a thread's menu and a double-click renames it: Enter or leaving the field
  saves the title, Escape keeps it as it was. Settings › Keyboard rebinds
  them all.
- **Kept in this browser** (`lemma.frame.sidebar.marks`): the pinned and
  active orders, and when threads were archived and unarchived, which order the
  list beyond when each was made; and whether the archived fold is open, and
  how tall.
