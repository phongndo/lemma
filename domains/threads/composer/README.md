# threads.composer

Where prompts are written: text, images pasted, dropped, or attached,
completions for the word being typed, and the buttons to send, steer, and
stop. Adds the composer to `ComposerRegion`, and draws what plugins add to
`ComposerNotices` (above the box), `ComposerControls` and `ComposerActions`
(its toolbar), `ComposerFooter` (under it), and `ComposerCompletions` (the
completion menu), all in [`@lemma/threads`](../contract/src/threads.ts). Its own
pieces go through the same slots and parts: `composer.attach` in
`ComposerActions`, `composer.answer` in `ComposerNotices` (what a plugin that
handled or refused the last prompt said: `Threads.answer`), and the defaults of
`ComposerQueuedPart` and `ComposerSuggestionPart`. Adds `composer.focus`
(`ThreadsActionIds.focusComposer`, key `/`) to `Actions`, and its `send`,
`whenBusy`, and `stop` settings to Settings › Keyboard (`SettingsGroups`). Requires `Threads`, `Models`
([`@lemma/llm/web`](../../llm/contract/src/web/models.ts)), `Workspace`
([`@lemma/workspace/web`](../../workspace/contract/src/web/workspace.ts)), and
the runtime's `Client`, `Notify`, `Router`, `Slots`, and `WebPlugins`.

| Config     | Default          | What it does                                                                                                                                                                                   |
| ---------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`     | `"enter"`        | `"enter"`: Enter sends and Shift+Enter starts a new line. `"mod+enter"`: ⌘Enter on macOS (Ctrl+Enter elsewhere) sends and Enter starts a new line                                              |
| `whenBusy` | `"queue"`        | What sending does while a turn runs. `"queue"`: the prompt waits, and goes as the next turn. `"steer"`: it joins the running turn after its current step. Alt with the send key does the other |
| `stop`     | `"escape-twice"` | `"escape-twice"`: Escape in the prompt twice within a second stops the running turn. `"escape"`: once does                                                                                     |

## Behavior

- **While a turn runs**, sending queues the prompt to go as the next turn, or
  with `whenBusy: "steer"` steers it, joining the turn after its current step;
  Alt with the send key, or on the send button, does the other. A queued
  prompt waiting to follow the turn can still steer it (`Threads.promote`),
  from its row's button. Escape in the prompt, twice within a second
  (`stop`), stops the turn: the first says so, and a single Escape meant for
  the completion menu never does, nor does one held down. Switching threads,
  or the turn ending, forgets a first Escape. Queueing is the default because a steer
  lands between steps and can redirect what the model was in the middle of,
  while a queued prompt can still be promoted.
- **Every prompt** goes with `Models.turnOptions()`. A new thread's first
  prompt creates it in the directory `Workspace.newChatDir` gives: a fresh
  worktree named from the prompt, when one is chosen.
- **Drafts.** An unsent prompt is kept per thread, and one for a new thread,
  across switching threads and the composer leaving the page (settings), in
  memory: closing or reloading the tab while any thread has one asks first.
- **Sending again.** The composer clears as a prompt goes out. One that was
  not sent returns to the thread it was written in, with its request id, ahead
  of whatever was typed there since, so sending it again unchanged cannot place
  it twice; an edit makes it a new prompt. A send asked for while one goes out
  waits, and goes once the first is accepted, if the composer still holds what
  it held when it was asked.
- **Earlier prompts.** Up in an empty prompt brings back the last one sent in
  the thread, read from its branch (`Threads.branch`) with its images, and
  again the one before; Down goes newer, and past the newest empties the
  prompt. While the prompt holds one unchanged, with the cursor at its start or
  end, Up and Down go on through them, and it is no draft (switching threads
  drops it, and closing the tab does not ask); an edit makes it a prompt of its
  own. One brought back opens no completion menu until it is edited.
- **Images** are PNG, JPEG, GIF, or WebP up to 3.75 MB each (`IMAGE_TYPES`,
  `MAX_IMAGE_BYTES` in `@lemma/llm`); other images, and files that are no
  images, are left out with a warning. They attach even when the selected model takes no images, with a
  note saying so.
- **Completions.** Enter or Tab with no suggestion in the menu yet, and a
  source still to answer, waits for it rather than sending the half-typed
  word.
