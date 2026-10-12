# threads

A session as the web app shows it: the thread page, its views (the transcript, the trajectory), and the composer. Its contract is [`@lemma/threads`](contract/src/threads.ts), with the projections the views share.

| Plugin                              | Halves | What it does                                                          |
| ----------------------------------- | ------ | --------------------------------------------------------------------- |
| [`threads.client`](client/)         | web    | Threads and the active one's log: provides `Threads`                  |
| [`threads.view`](view/)             | web    | The page for one thread, and for a new one, with its views as tabs    |
| [`threads.transcript`](transcript/) | web    | The session as a conversation                                         |
| [`threads.trajectory`](trajectory/) | web    | Every request, response, and tool call, as a network panel shows them |
| [`threads.composer`](composer/)     | web    | A prompt being written, with its completions, controls, and queue     |
| [`threads.archived`](archived/)     | web    | Archived threads, as a settings section                               |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add       | `Views` (a view of a thread), `ToolViews` (how a tool's calls show), `ThreadHeader`, `ThreadActions`, `ComposerControls`, `ComposerCompletions`, `ComposerActions`, `ComposerNotices`, `ComposerFooter`, `TrajectoryTabs`, `TrajectoryActions`               |
| Intercept | Parts that take over how a piece draws: `ChatToolPart`, `ChatUserPart`, `ChatThinkingPart`, `ChatWorkPart`, `ChatWorkGroupPart`, `ChatWorkingPart`, `ChatTurnFooterPart`, `ComposerQueuedPart`, `ComposerSuggestionPart`, `SidebarRowPart`; `ComposerRegion` |
| Observe   | `Threads`' signals: the active thread, its branch, what runs                                                                                                                                                                                                 |
| Call      | `Threads`: open, send, steer, queue, rename                                                                                                                                                                                                                  |
| Serve     | `Threads`: a plugin providing it replaces `threads.client`                                                                                                                                                                                                   |
