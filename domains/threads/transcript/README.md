# threads.transcript

Shows the open thread as a conversation: each prompt, the answers as markdown,
thoughts and tool calls as lines that open to what they hold, a divider where
the context was compacted, and under each finished turn its model, tokens,
cost, and time. It adds:

- the `transcript` view to `Views`, at order -10, first, with the composer under
  it;
- the defaults of the chat's parts, in the phase `default`: `ChatUserPart`,
  `ChatThinkingPart`, `ChatToolPart`, `ChatWorkPart`, `ChatWorkGroupPart`,
  `ChatWorkingPart`, and `ChatTurnFooterPart`
  ([`@lemma/threads`](../contract/src/parts.tsx));
- `chat.copy-prompt` and `chat.prompt-link` to `PromptActions`, under a prompt;
- its settings to Settings › General › Conversation (`SettingsGroups`).

A tool's calls show as its `ToolViews` item says. It reads `Threads.branch`,
`Threads.live`, and `Threads.queue`, the first two through the contract's
projections (`createProjector`, `foldTurn`, `foldRunning`, `draftEntries`,
`queuePlaces`), which another view can share.

| Config        | Default | What it does                                                                                                                                                        |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expandTools` | `false` | Opens every tool call, and every run of calls in folded work, to its arguments and output, instead of one line                                                      |
| `foldWork`    | `true`  | Folds a turn's thinking, tool calls, and failed attempts into one line above its answer, and one more after each steer or compaction, the running turn's as it goes |
| `promptRail`  | `true`  | A tick per prompt along the chat's left edge, with two prompts or more and a mouse or trackpad: pointing previews one, clicking goes there                          |

## Behavior

- **Following the output.** The view keeps to the newest output while the
  reader is at the bottom, and stops once they scroll up (`createStickToBottom`
  in `@lemma/web/scroll`).
- **Find.** `thread.find` (mod+F, in `Actions`) searches what the chat shows,
  not what a closed thought or tool call holds. Unbinding it leaves mod+F to the
  browser.
- **Steers** show at the end of the running turn, where they will join
  (`queuePlaces`' `joining`), and can be withdrawn until the turn takes them.
  The work after a steer folds on its own, so a steer stays where it showed.
- **Prompt links** end `#prompt-<event id>`. Opened, the chat shows that prompt
  at its top.
- **Stopped turns.** Calls the stop cut short show "stopped", not "failed"
  (`ToolResultView.stopped`), and are not counted as failed. A turn's section
  says how it ended (`data-end`), for a stylesheet.
- **Tool results.** A call with no result once its turn has ended shows "no
  result". The default body reads the `details` the bundled tools write: a
  unified diff in `diff` or `patch`, `exitCode` (shown when not 0),
  `truncated`, and `fullOutputPath`. Output shows its first 14 lines until asked
  for more.
- **Displays.** A `ToolViews` item's `display` (a page `html_render` drew)
  shows below the fold holding its call, open or closed. It is drawn once per
  call, so it does not reload as the turn goes on.
- **Runs of calls** in folded work are one `ChatWorkGroupPart` line, named from
  each tool's `ToolViews` `action`.
- **Errors.** A model error whose message holds a JSON body shows the
  description it holds (`error_description`, `message`, `detail`, or
  `description`) instead of the JSON.
