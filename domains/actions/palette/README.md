# actions.palette

The command palette (Cmd+K on macOS, Ctrl+K elsewhere): every action, host
command, thread, and project in one list, ranked as you type, and the pages
some of them open. It adds the
`palette.open` action (`ActionIds.palette`: `mod+k`, `global`, `hidden`) to
`Actions`, the palette to `Layers` (`@lemma/frame`) at order 30 as the dialog
`palette`, and three sources to `PaletteSources`
([`@lemma/actions`](../contract/src/actions.ts)), which it lists with any a
plugin adds. While open, it claims the host's questions
(`Interactions.claim`) and asks them in place of the question dialog, so a
command that asks goes on here. Requires `Client`, `Threads`
(`@lemma/threads`), `Workspace` (`@lemma/workspace/web`), `Commands`
(`@lemma/commands/web`), `Interactions`, `Dialogs`, `WebPlugins`, and `Slots`.
No config.

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
  Recent, then each source in order without them, up to its `browse`, under
  its `heading`; a source without one (the commands) leads unnamed.
- **Pages.** An item or action with a `page` (`PalettePage`) is marked with a
  chevron, and picking it opens its list in place of the palette's, at the
  item it marks `current`, if any. A page names itself in the empty field,
  with a back button in place of its prompt, and its items may open pages of
  their own (Appearance's Theme…). Escape clears what was typed,
  then goes back to the list the page was opened from as it was left, what
  was typed and the row chosen; Backspace in an empty field goes back too.
- **Searching elsewhere.** A source's `search` (the threads' asks the host
  what was said in them) is asked once two letters are typed and typing has
  paused 200 ms: `Searching messages…` shows meanwhile, then what it found
  under `In messages`, but for what the list already holds.
- **Searching** is `rank` from `@lemma/web/match`: every word must match an
  item's title or, more weakly, its keywords: at the top level every source's
  items, and on a page its own. The 20 choices last made, kept
  in this browser (`lemma.palette.recent`), rank a little higher. At most 60
  results show.
- **Focus.** An item without `keepOpen` or `input` runs once the palette has
  closed and given focus back to what had it, so one that opens a dialog or
  focuses the prompt keeps its focus.
- **Questions.** The host's come before an item's own `input`, since a
  running command waits on them. Esc dismisses a question (the host's cancels
  its command) and keeps the palette open; with no question it clears the
  query, then goes back from a page, then closes. Backspace in an empty field steps back from an item's
  `input`.
- **Keys** in the list are `listKey`'s (`@lemma/web/keys`), and PgUp and PgDn
  move by eight. Its own key, `mod+k`, closes it first: where the modifier is
  Ctrl, `listKey` would take Ctrl+K as up.
- **Opening.** `palette.open` does nothing while the host waits on a question
  and the palette is closed: the question keeps the screen until answered. Run
  with an action's id, as the keymap runs it for an action with `input`, it
  closes any open dialog and opens asking for that action's value, or at its
  page.
