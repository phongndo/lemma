# threads.transcript

Shows the open thread as a conversation: each prompt, the answers as markdown,
thoughts and tool calls as lines that open to what they hold, a divider where
the context was compacted, and under each finished turn its model, tokens,
cost, and time. Adds the `transcript` view to `Views` (order -10, first, with the
composer under it), and the defaults of the chat's parts in the phase
`default`: `ChatUserPart`, `ChatThinkingPart`, `ChatToolPart`,
`ChatWorkPart`, `ChatWorkGroupPart`, `ChatWorkingPart`, and `ChatTurnFooterPart`
([`@lemma/threads`](../contract/src/parts.tsx)). A tool's calls show as its
`ToolViews` item says. It reads `Threads.branch`, `Threads.live`, and `Threads.queue`, the first two through the
contract's projections (`createProjector`, `foldTurn`, `foldRunning`,
`draftEntries`, `queuePlaces`), which another view can share. Requires `Threads` and the
runtime's `Client`, `Router`, and `Slots`.

| Config        | Default | What it does                                                                                                                                                        |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expandTools` | `false` | Opens every tool call, and every run of calls in folded work, to its arguments and output, instead of one line                                                      |
| `foldWork`    | `true`  | Folds a turn's thinking, tool calls, and failed attempts into one line above its answer, and one more after each steer or compaction, the running turn's as it goes |
| `promptRail`  | `true`  | A tick per prompt along the chat's left edge, with two prompts or more and a mouse or trackpad: pointing previews one, clicking goes there                          |

## Behavior

- **Following the output.** The view keeps to the newest output while the
  reader is at the bottom, and stops once they scroll up. Its scroll position
  is kept with each history entry, so back and forward return to it.
- **Find.** `thread.find` (mod+F, in `Actions`) opens a bar over the chat
  that highlights where its text occurs, ignoring case, and goes from one to
  the next (Enter, Shift+Enter); Escape closes it. It searches what the chat
  shows, so not what a closed thought or tool call holds, and keeps up as the
  transcript changes. Unbinding the key leaves mod+F to the browser.
- **Steers.** A steer sent while a turn runs shows at once at the end of the
  turn, where it will join, as it will look once the turn places it after its
  current step: the prompt as sent under a quiet "Steer" mark
  (`ChatUserPart`'s `steer`), which is not part of what was sent. Until the
  turn takes it, a button beside it withdraws it. The step under way finishes
  above it; the work after it, which the model did having read it, folds on
  its own below it (each stretch of work between steers is a fold of its own,
  timed from the steer), so a steer stays where it showed once placed and once
  the turn ends, in the log's order. Which waiting prompts show here is `queuePlaces`' `joining`:
  the composer shows the rest, what a stopped turn left among them.
- **Open and closed.** What the reader opens or closes stays so across thread
  switches, for as long as the plugin runs.
- **Tool results.** A call with no result once its turn has ended, or with no
  turn running, shows "no result" (`state` `interrupted`). The default body
  reads a result's `details` as the bundled tools write them: a unified diff in
  `diff` or `patch` (drawn in place of a successful call's output, its added
  and removed lines counted on the call's line), `exitCode` (shown when not 0),
  `truncated`, and `fullOutputPath`. Output shows its first 14 lines until
  asked for more.
- **Runs of calls.** In folded work, two or more calls in a row, with only
  thoughts between them, are one `ChatWorkGroupPart` line saying what they did
  from each tool's `ToolViews` `action`; it names two kinds at most and counts
  the rest.
- **Thoughts.** A collapsed thought shows its title, a line such as
  `**Checking the tests**` or `# Plan` (the latest while it streams), else its
  first line.
- **Errors.** A model error whose message holds a JSON body shows the text
  around the body and the description it holds (`error_description`,
  `message`, `detail`, or `description`) instead of the JSON.
