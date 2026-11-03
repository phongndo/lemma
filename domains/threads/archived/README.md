# threads.archived

Settings › Archived: every archived thread, kept as a browser keeps its history,
to find, open, unarchive, or delete, one at a time or many at once. It adds:

- the section `archived` to `SettingsSections`
  ([`@lemma/settings`](../../settings/contract/src/index.ts));
- its delete dialog (`DeleteThreadsDialog`, from
  [`@lemma/threads`](../contract/src/delete.tsx)) to `Layers`;
- `archived-page.open` (Archived threads) and the page's keys to `Actions`.

Its threads are not in the settings search: the palette (⌘P) finds an archived
thread. No config.

## Behavior

- **Grouped by date** of last use, the most recent first. Archiving is not
  using a thread (`Sessions.mark` leaves `updatedAt`).
- **Search and project.** The search keeps threads whose title, project,
  folder, or branch hold every word typed. A worktree's threads are its
  repository's project (`Workspace.projectOf`). Both are in the page's address
  (`?q=…&project=…`, `project=none` for no project), so a reload keeps them.
- **Selecting** works as in a file manager: Shift-click picks a run. The
  selection outlives the search, and the actions take selected threads the
  search hides. A thread leaves the selection once it is unarchived.
- **Keys.** ↑ and ↓ move between rows, with Shift to extend the run, and Space
  picks the row in focus. Escape clears the selection and ⌘A (Ctrl+A) selects
  every thread shown; Settings › Keyboard rebinds them
  (`archived-page.clear-selection`, `archived-page.select-all`).
- **Deleting** is for good. A thread whose turn still runs cannot be deleted.
