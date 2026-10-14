# threads.composer

Where prompts are written: text, images pasted, dropped, or attached,
completions for the word being typed, and the buttons to send, steer, and
stop. Adds the composer to `ComposerRegion`, and draws what plugins add to
`ComposerNotices` (above the box), `ComposerControls` and `ComposerActions`
(its toolbar), `ComposerFooter` (under it), `ComposerCompletions` (the
completion menu), `PromptCommands` (it runs those with `run`), and `ComposerTakeovers` (a plugin's banner just above the box, which
then takes the text box and the send button, or its line above the box), all
in [`@lemma/threads`](../contract/src/threads.ts). Its own
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
| `whenBusy` | `"steer"`        | What sending does while a turn runs. `"steer"`: it joins the running turn after its current step. `"queue"`: the prompt waits, and goes as the next turn. Alt with the send key does the other |
| `stop`     | `"escape-twice"` | `"escape-twice"`: Escape in the prompt twice within a second stops the running turn. `"escape"`: once does                                                                                     |

## Behavior

- **While a turn runs**, sending steers it: the prompt joins the turn after
  its current step, and shows nowhere in the composer, only in the transcript
  where it will join (`Threads.queue`'s steers). Alt with the send key, or on
  the send button, queues it instead, to go as the next turn, and
  `whenBusy: "queue"` swaps the two. Queued prompts show just above the box,
  in the completion menu's look (the menu covers them while open), under a
  thin header with their count that opens and closes them (closed, the
  queue is that one line, for every thread until it is opened again). Each is
  one line, the next first, and can still steer the turn (`Threads.promote`)
  or be withdrawn, from its row's buttons. A stopped or failed turn leaves what
  it held queued for the next prompt, steers too: with no turn running they
  show above the box with the rest, where they can be withdrawn. Which waiting
  prompts show here is `queuePlaces`' `next`. The queue is in the page's flow:
  the conversation makes room for it rather than going under it. Escape in the
  prompt, twice within a second (`stop`), stops the turn: the first says so,
  and a single Escape meant for the completion menu never does, nor does one
  held down. Switching threads, or the turn ending, forgets a first Escape.
  Steering is the default because a prompt sent mid-turn is most often about
  the work under way, and the sooner the model reads it the less it does that
  the prompt would change.
- **Taken** (`ComposerTakeovers`: the agent's questions, say). The first
  item holding the open thread draws its banner just above the box, in a
  panel in the completion menu's look and the page's flow, as the queue (the
  menu covers it while open), and the text box, Enter, and the send button
  (its tip says what it does, as the item does) are its own, the item offered
  each key in the text box first (`keyDown`); the thread's draft waits, and comes back when it lets go. It
  never takes the box while the person has a prompt of their own unsent
  (written, or going out), nor after they let it go (Escape in the box, or
  the banner's own control) until what it holds the box for changes: then its
  line shows above the box, whose control takes the box, the prompt kept. A
  prompt sent instead lets it go. While taken, Escape lets go rather than
  stopping the turn (the stop button still stops it), Up and Down bring back
  no sent prompt, and `ComposerActions` are left out; images pasted or
  dropped are refused, as what is written is text only. A box that changed
  under someone's keys would send their words to the wrong place, which is why
  their own prompt keeps it rather than a pause in their typing.
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
  word. A source's `span: "line"` completes the prompt's first line from its
  trigger, spaces and all, so a command and then its arguments complete in
  turn; past the command's name, a line no source answers closes the menu,
  so a prompt starting with a path is not in its way. While the cursor ends
  the prompt, the rest of the active suggestion and its `hint` show muted after
  it (with none active, the source's own `hint`), and Tab takes it. Enter picks a
  suggestion and, for one marked `submit` (a command needing nothing more),
  sends too; Tab only completes. A source's note stands in for "No matches",
  so an empty menu can say why.
- **Commands.** A prompt that names a `PromptCommands` command, or one of its
  subcommands, with `run` (`/new`, `/mcp reconnect github`) runs that instead
  of being sent: the box clears first (the command may go to another thread),
  and gets the prompt back, with the error shown, when it fails. One still
  missing a subcommand or a required argument says what it takes and stays. A
  command whose tree runs nothing here is sent as typed, for the host to
  answer.
