# threads.archived

Settings › Archived: every archived thread, kept as a browser keeps its history, to find, open, unarchive, or delete,
one at a time or many at once. Adds the section `archived` to `SettingsSections`
([`@lemma/settings`](../../settings/contract/src/index.ts)), with a group of its threads in `SettingsGroups` that
answers the settings search; its delete dialog to `Layers`; and to `Actions`, `archived-page.open` (Archived threads)
and the page's keys.
Requires `Client`, `Threads`, `Workspace` (`@lemma/workspace/web`), `Settings`, `Dialogs`, and `Slots`. No config.

## Behavior

- **Grouped by date or project.** By date (the default), threads fall under Today, Yesterday, Previous 7 days, Previous
  30 days, then months, by when each was last used: archiving is not using a thread (`Sessions.mark` leaves
  `updatedAt`), so this is when it was last worked in. By project, a worktree's threads are its repository's
  (`Workspace.projectOf`), and threads with none are under "No project". Either way the most recently used come first.
  The choice is kept in this browser.
- **Quiet until wanted.** One toolbar row holds the search, a count, the project filter, and the grouping, as icons with
  tooltips. A row shows its title, its project, and its worktree's branch; an agent's has a mark before its title, which
  names the thread it works for. Checkboxes keep their place but show under the pointer, with the keyboard on them, or
  while any thread is selected.
- **Search and project.** The search keeps the threads whose title, project, folder, or branch hold every word typed;
  the filter, or a row's project, narrows the page to one project's. Both are in the page's address
  (`?q=…&project=…`), so a reload, or back and forward, keeps them.
- **A row** ends with when it was last used, or a mark while a turn still runs in it (or waits on you). Its branch reads
  fainter once its worktree was removed on archiving, which unarchiving makes again. Its title opens the thread, as a
  link does: with a modifier, the browser opens it elsewhere. Under the pointer, or with the keyboard in it, its end
  offers Unarchive and Delete, which asks again in place.
- **Selecting**, as a file manager's list does. A click on a row (but its title and buttons) or its checkbox picks it;
  Shift-clicking another picks the run from the one picked last, and a second Shift-click from there grows or shrinks
  that run rather than adding to it. A heading's checkbox picks its group. While some are selected, the toolbar holds
  them beside the search: how many, a checkbox for every thread shown, and Unarchive, Delete (after a dialog that says
  how many go), and Clear. The search stays usable: the selection outlives it, so one can be gathered across several
  searches, and the toolbar says how many selected threads the search hides, which the actions still take.
- **Keys.** ↓ goes from the search into the list, ↑ and ↓ move between rows, and ↑ from the top returns to the search;
  with Shift, the run from the row picked last follows, as Shift-clicking does. Space picks the row in focus. Escape
  clears the selection (before it closes settings), and ⌘A (Ctrl+A) selects every thread shown, wherever focus is on
  the page but a field: these two are actions (`archived-page.clear-selection`, `archived-page.select-all`), so
  Settings › Keyboard can change them. Leaving the page drops the selection.
- **Deleting** is for good. A thread whose turn still runs cannot be deleted, and is kept.
- **Empty**, the page says what archiving is and where to do it.
