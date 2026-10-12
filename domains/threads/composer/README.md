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
(`ThreadsActionIds.focusComposer`, key `/`) to `Actions`, and its `send`
setting to Settings › Keyboard (`SettingsGroups`). Requires `Threads`, `Models`
([`@lemma/llm/web`](../../llm/contract/src/web/models.ts)), `Workspace`
([`@lemma/workspace/web`](../../workspace/contract/src/web/workspace.ts)), and
the runtime's `Client`, `Notify`, `Router`, `Slots`, and `WebPlugins`.

| Config | Default   | What it does                                                                                                                                      |
| ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send` | `"enter"` | `"enter"`: Enter sends and Shift+Enter starts a new line. `"mod+enter"`: ⌘Enter on macOS (Ctrl+Enter elsewhere) sends and Enter starts a new line |

## Behavior

- **While a turn runs**, sending steers it: the prompt joins the turn after its
  current step. Alt with the send key queues the prompt to follow the turn
  instead, and Escape in the prompt stops the turn.
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
- **Images** are PNG, JPEG, GIF, or WebP up to 3.75 MB each (`IMAGE_TYPES`,
  `MAX_IMAGE_BYTES` in `@lemma/llm`); other images, and files that are no
  images, are left out with a warning. They attach even when the selected model takes no images, with a
  note saying so.
- **Completions.** Enter or Tab with no suggestion in the menu yet, and a
  source still to answer, waits for it rather than sending the half-typed
  word.
