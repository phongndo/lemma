# threads.client

Keeps the web app's threads in step with the host: the list of threads, which
one is open, the open thread's log and what is streaming into it, which
threads are running, what each asks of the person, and sending prompts. Provides `Threads`
([`@lemma/threads`](../contract/src/threads.ts)), which the domain's other
plugins read. It follows the host through the `sessions.changes` and
`agent.activity` channels and the open thread's `sessions.log` and
`agent.output`, and calls the other `sessions.*` and `agent.*` channels. Adds `threads.running` to
`PluginsFacts`: how many turns are running, on the Plugins page, whose reload
restarts host plugins mid-turn. Requires the runtime's `Client`, `Notify`,
`Router`, and `Slots`. No config.

## Behavior

- **The address names the open thread** (`/threads/<id>`, `ThreadRoute`):
  `select` navigates and the active thread follows, so a link, back and
  forward, and a reload open the thread they name. An id no listed thread has
  opens nothing, and a page that is not a thread's (settings) keeps the thread
  it was opened over. A deleted thread's address goes to the new-thread page,
  and an address from before threads had paths (`/#<id>`) becomes the
  thread's own.
- **Threads exist before their first prompt**, as a browser's tabs do:
  `newThread` creates an empty session (`isBlank`, with no prompt on its way)
  where it is told, else in `pendingCwd` (where a plugin says new threads
  start: the workspace keeps it at the shown thread's project), else in the
  shown thread's directory, and goes to it; one
  this tab made and still empty in that directory (nothing written in it
  either) is gone to instead, so there is one new thread per directory. Asked
  for with nowhere to start one yet (the workspace not yet known), it goes to
  the new-thread page instead of starting one in the host's directory. The
  new-thread page (`/`, where the app opens) shows the newest blank thread this
  tab made with nothing written in it, or creates one in `pendingCwd` once
  that is set, so opening the app does not pile them up; until then, its first
  prompt creates it. Asked for again while one is being made in that
  directory, it waits for that one.
- **This tab's blank threads.** The blank threads a tab made are its own (kept
  in the tab's storage, across its reloads): only those it lands on, moves, or
  deletes, never one another tab, window, or `lemma sessions new` made. One
  moves rather than being made again (`sessions.relocate`, keeping its id,
  address, draft, and pane): `newThread` with `inPlace` (another project
  picked), or a first prompt `send` gives another `cwd` (its own worktree); for
  one it did not make, a new thread there takes the prompt. Left with nothing
  kept for it (no draft, nothing a plugin holds for it: `ThreadHolds`, as a
  page in its pane), it is deleted, as a tab closed is. While something is
  kept for it, it is marked `kept` on the host, so the host's sweep of empty
  sessions (one a closed tab left) passes it over.
- **Drafts.** `drafts` holds each thread's unsent prompt as the composer
  writes it (`setDraft`). Lists hear at once when a thread gains or loses
  one, and its text a moment after the last change. Its text is kept in the
  browser (`lemma.threads.client.drafts`), written a moment after the last
  change and as the page goes, merged with what other tabs wrote, whose own
  changes arrive as they save them; it comes back after a reload, and its
  images last while the page does. A deleted thread's goes with it.
- **Sending in the background.** `send` with `background` creates a thread
  (in `cwd`, else the shown thread's directory) and sends to it without going
  there. Refused, the answer shows where the prompt was written (the
  new-thread page's, with no thread shown), and the thread made for it is
  deleted.
- **Only the open thread is followed.** Its log, streaming drafts, running
  tools' output, and queue are held; opening another drops them and reads its
  log beside its `agent.output`, which opens with what the agent has of it
  (`agent.view`'s), so a thread opened or reconnected mid-turn shows the turn
  so far. Only its model and tool output reach the page: `agent.activity` is
  opened without output (`{ output: false }`), so threads streaming in the
  background cost it their turns' starts and ends and their queues' changes,
  not every delta: a page showing one thread while two others streamed six
  answers between them received 17 kB in 71 messages rather than 93 kB in
  412, the rest of it the sidebar's `sessions.changes` and the workspace's
  calls. A log `preload` fetched is used if its thread opens within 15
  seconds.
- **Streaming.** Deltas and tool output are applied together once per
  animation frame, or at once when 256 are waiting (a hidden tab gets no
  frames).
- **Running threads** follow `agent.activity`'s turn events; when a prompt it
  sent settles, it asks `agent.running` again, in case those were lost.
- **Attention** (`attention`) is one record per thread, which the sidebar and
  notifications both read, so they agree: waiting on the person
  (the first `ThreadWaits` label), else working, else a turn's end not yet
  seen: `Done`, or `Failed` (an error) and `Out of steps`; a turn the person
  cancelled leaves nothing. A turn that ends while its thread shows in a window
  the person is looking at (the page visible, its window focused) is seen at
  once; one that ends otherwise stays until its thread shows to them so, or
  `markSeen`, and a new turn in a thread leaves the last one's end behind.
  Unseen ends are kept in the browser (`lemma.threads.client.unseen`), shared
  with its other tabs, so a reload keeps them and one seen in another tab is
  seen here; a deleted thread's goes with it. Times count from when this page
  saw a turn start or a thread begin waiting.
- **Failures are reported, not thrown.** A method whose call to the host fails
  reports it through `Notify` rather than rejecting; `send` resolves false.
- **For a replacement.** The state it keeps is built with the contract's pure
  functions (`appendLog`, `resolveLeaf`, `trackTurn`, `newerQueue`, and
  `applyDelta`, `joinLive`, `reconcileLive` for `live`, against what is
  over, `Finished`, noted as the log grows: `noteLogged`, `noteEnded`; and
  `attentionOf` and `tells` for `attention`), which a replacement can reuse so
  the views read the same shapes.
