# threads.archived

Settings › Archived: every archived thread, kept as a browser keeps its history, to find, open, unarchive, or delete,
one at a time or many at once. Adds the section `archived` to `SettingsSections`
([`@lemma/settings`](../../settings/contract/src/index.ts)); its delete dialog (`DeleteThreadsDialog`, from
[`@lemma/threads`](../contract/src/delete.tsx)) to `Layers`; and to `Actions`,
`archived-page.open` (Archived threads) and the page's keys. Its threads are not in the settings search: the palette
(⌘P) finds an archived thread.
Requires `Client`, `Threads`, `Workspace` (`@lemma/workspace/web`), `Settings`, `Dialogs`, and `Slots`. No config.

## Behavior

- **Grouped by date.** Threads fall under Today, Yesterday, Previous 7 days, Previous 30 days, then months, by when
  each was last used, the most recent first: archiving is not using a thread (`Sessions.mark` leaves `updatedAt`), so
  this is when it was last worked in.
- **Quiet until wanted.** One toolbar row holds the search, a count, and the project filter, as an icon with a tooltip.
  A row, on the settings' row grid, shows its title, its project, and its worktree's branch; an agent's has a mark
  before its title, which names the thread it works for. Its checkbox leads it, faint until the pointer or the keyboard
  is on the row or any thread is selected, so rows start where every section's do; a heading's shows only then.
- **Search and project.** The search keeps the threads whose title, project, folder, or branch hold every word typed.
  The project filter narrows the page to one project's threads: a worktree's are its repository's
  (`Workspace.projectOf`), and threads with none are "No project". A row's project is a shortcut to the same filter,
  and leaves the row while the filter names one. Both are in the page's address (`?q=…&project=…`, `project=none` for
  no project), so a reload, or back and forward, keeps them.
- **A row** ends with when it was last used, or a mark while a turn still runs in it (or waits on you). Its branch reads
  fainter once its worktree was removed on archiving, which unarchiving makes again. Its title opens the thread, as a
  link does: with a modifier, the browser opens it elsewhere. Under the pointer, or with the keyboard in it, its end
  offers Unarchive and Delete, which asks in place (`ConfirmDelete` in `@lemma/look`), as one thread's delete does
  everywhere.
- **Selecting**, as a file manager's list does. A click on a row (but its title and buttons) or its checkbox picks it;
  Shift-clicking another picks the run from the one picked last, and a second Shift-click from there grows or shrinks
  that run rather than adding to it. A heading's checkbox picks its group. While some are selected, the toolbar holds
  them beside the search: how many, a checkbox for every thread shown, and Unarchive, Delete (after a dialog that says
  how many go), and Clear. The search stays usable: the selection outlives it, so one can be gathered across several
  searches, and the toolbar, and the delete dialog, say how many selected threads the search hides, which the actions
  still take. A thread leaves the selection once it is unarchived, here or elsewhere, so archiving it again does not
  bring it back selected; one that fails to unarchive stays selected.
- **Keys.** ↓ goes from the search into the list, ↑ and ↓ move between rows (↓ from the last goes round to the first,
  as in every list), and ↑ from the top returns to the search; with Shift, the run from the row picked last follows, as
  Shift-clicking does, and stops at the ends. Space picks the row in focus. Escape
  clears the selection (before it closes settings), and ⌘A (Ctrl+A) selects every thread shown, wherever focus is on
  the page but a field (in the search, it selects the text): these two are actions (`archived-page.clear-selection`, `archived-page.select-all`), so
  Settings › Keyboard can change them. Leaving the page drops the selection.
- **Deleting** is for good. A thread whose turn still runs cannot be deleted, and is kept.
- **Empty**, the page says what archiving is and where to do it.
