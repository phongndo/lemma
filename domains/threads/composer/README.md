# threads.composer

Where prompts are written: text, attached images, completions for the word
being typed, and the buttons to send, steer, and stop. It adds the composer to
`ComposerRegion`. It draws what plugins add to these, all in
[`@lemma/threads`](../contract/src/threads.ts):

- `ComposerNotices`, above the box;
- `ComposerControls` and `ComposerActions`, its toolbar;
- `ComposerCompletions`, the completion menu;
- `PromptCommands`, which it runs with `run`;
- `ComposerTakeovers`, a plugin's banner that takes the text box and the send
  button (its doc comment says when).

Its own pieces go through the same slots and parts:

- `composer.attach` in `ComposerActions`;
- `composer.edit` in `PromptActions`: Edit from here, under a prompt in the
  transcript;
- `composer.answer` in `ComposerNotices`: what a plugin that handled or refused
  the last prompt said (`Threads.answer`);
- the defaults of `ComposerQueuedPart` and `ComposerSuggestionPart`.

It adds `composer.focus` (`ThreadsActionIds.focusComposer`, key `/`) to
`Actions`. Its `send`, `whenBusy`, and `stop` settings are in Settings ›
General › Composer (`SettingsGroups`).

| Config     | Default          | What it does                                                                                                                                                                                                                            |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`     | `"enter"`        | `"enter"`: Enter sends and Shift+Enter starts a new line. `"mod+enter"`: ⌘Enter on macOS (Ctrl+Enter elsewhere) sends and Enter starts a new line. ⌘Enter, or ⌘⇧Enter while it sends, runs the prompt in a new thread in the background |
| `whenBusy` | `"steer"`        | What sending does while a turn runs. `"steer"`: it joins the running turn after its current step. `"queue"`: the prompt waits, and goes as the next turn. Alt with the send key does the other                                          |
| `stop`     | `"escape-twice"` | `"escape-twice"`: Escape in the prompt twice within a second stops the running turn. `"escape"`: once does                                                                                                                              |

## Behavior

- **Steer by default.** A prompt sent mid-turn is most often about the work
  under way, and the sooner the model reads it the less it does that the prompt
  would change.
- **Queued prompts** show above the box (`queuePlaces`' `next`), steers a
  stopped turn left among them. Each can still steer the running turn
  (`Threads.promote`) or be withdrawn.
- **Stop.** The send button stops the turn while the box is empty. An Escape
  meant for the completion menu never stops it.
- **New threads.** A blank thread's first prompt goes in the directory
  `Workspace.newChatDir` gives. Every prompt goes with `Models.turnOptions()`.
- **Drafts.** `Threads` keeps an unsent prompt per thread across switches and
  reloads (`Threads.setDraft`). Closing the tab asks first only for what a
  reload would lose, such as a draft's images.
- **Sending again.** A prompt that did not get through comes back with its
  request id, so sending it again unchanged cannot place it twice.
- **Earlier prompts.** Up in an empty box brings back the prompts sent on the
  thread's branch, with their images. Down goes newer.
- **Edit from here** checks the thread out to before that prompt's turn
  (`promptBases`, `Threads.checkout`) and puts the prompt back in the box.
  Files stay as they are: Lemma keeps no snapshots of them.
- **Images** are PNG, JPEG, GIF, or WebP up to 3.75 MB each (`IMAGE_TYPES`,
  `MAX_IMAGE_BYTES` in `@lemma/llm`). Others are left out with a warning.
- **Completions.** Enter or Tab waits for a source still to answer rather than
  sending a half-typed word. A source's note stands in for "No matches".
- **Commands.** A failing `PromptCommands` command puts the prompt back with
  its error. One missing a subcommand or a required argument says what it
  takes.
