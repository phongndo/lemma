# actions.palette

The command palette (Cmd+K on macOS, Ctrl+K elsewhere): every action, host
command, thread, and project in one list, ranked as you type, and the pages
some of them open. Adds the `palette.open` action (`ActionIds.palette`:
`mod+k`, `global`, `hidden`) to `Actions`, and the palette to `Layers`
(`@lemma/frame`) at order 30 as the dialog `palette`. Adds three sources to
`PaletteSources` ([`@lemma/actions`](../contract/src/actions.ts)), and lists
them with any a plugin adds. While open, it claims the host's questions
(`Interactions.claim`) and asks them in place of the question dialog, so a
command that asks goes on here. No config.

| Source             | Order | What it lists                                                                                                                                                                                                                      |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `palette.commands` | 0     | `Actions` not `hidden` whose `when` holds, each with its first key (the user's `bindings` over its own), then the host's commands (`Commands`), run `keepOpen`                                                                     |
| `palette.threads`  | 10    | Threads, latest first, each with what it waits on (`ThreadWaits`) or whether it works; also found by project, folder, id, `pinned`, `archived`, and what was said in them (`sessions.search`, `In messages`); picking one opens it |
| `palette.projects` | 20    | Projects, also found by path; picking one starts a new thread in it                                                                                                                                                                |

Threads and projects are `browse: 0`: what is typed finds them among the
commands, and Search threads (`ActionIds.searchThreads`, `mod+p`) opens a page
of the threads, searched the same way.

## Behavior

- **Browsing.** With nothing typed, up to five recent choices lead under
  Recent. Then each source follows in order, up to its `browse`.
- **Searching** is `rank` from `@lemma/web/match`: every word must match an
  item's title or, more weakly, its keywords. The 20 choices last made, kept in
  this browser (`lemma.palette.recent`), rank a little higher. At most 60
  results show.
- **A source's `search`** (the threads' asks the host what was said in them)
  runs once two letters are typed and typing has paused 200 ms.
- **Pages.** Picking an item with a `page` (`PalettePage`) opens its list in
  place of the palette's. Escape clears what was typed, then goes back.
  Backspace in an empty field goes back too.
- **Focus.** An item without `keepOpen` or `input` runs once the palette has
  closed and given focus back. So an item that opens a dialog keeps its focus.
- **Questions.** The host's questions come before an item's own `input`, since
  a running command waits on them. Escape dismisses a question, which cancels
  its command.
- **Keys** in the list are `SearchListPart`'s
  ([`@lemma/look`](../../look/contract/src/parts.tsx)): ↑ and ↓ move, PgUp and
  PgDn move by eight, and mod+1 … mod+9 pick. `mod+k` closes the palette, since
  with Ctrl as the modifier the list would read Ctrl+K as up.
- **Opening.** `palette.open` does nothing while the host waits on a question:
  the question keeps the screen until answered. Run with an action's id, as
  the keymap runs an action with `input`, it opens asking for that action's
  value, or at its page.
