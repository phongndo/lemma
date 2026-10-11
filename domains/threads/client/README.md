# threads.client

Keeps the web app's threads in step with the host: the list of threads, which
one is open, the open thread's log and what is streaming into it, which
threads are running, and sending prompts. Provides `Threads`
([`@lemma/threads`](../contract/src/threads.ts)), which the domain's other
plugins read. It follows the host through the `sessions.changes` and
`agent.activity` channels and the open thread's `sessions.log`, and calls the
other `sessions.*` and `agent.*` channels. Adds `threads.running` to
`PluginsFacts`: how many turns are running, on the Plugins page, whose reload
restarts host plugins mid-turn. Requires the runtime's `Client`, `Notify`,
`Router`, and `Slots`. No config.

## Behavior

- **The address names the open thread** (`/threads/<id>`, `ThreadRoute`):
  `select` navigates and the active thread follows, so a link, back and
  forward, and a reload open the thread they name. An id no listed thread has
  opens nothing, and a page that is not a thread's (settings) keeps the thread
  it was opened over. A deleted thread's address goes to a new thread, and an
  address from before threads had paths (`/#<id>`) becomes the thread's own.
- **Only the open thread is followed.** Its log, streaming drafts, running
  tools' output, and queue are held; opening another drops them and reads its
  log beside what the agent has of it (`agent.view`), so a thread opened or
  reconnected mid-turn shows the turn so far. A log `preload` fetched is used
  if its thread opens within 15 seconds.
- **Streaming.** Deltas and tool output are applied together once per
  animation frame, or at once when 256 are waiting (a hidden tab gets no
  frames).
- **Running threads** follow `agent.activity`'s turn events; when a prompt it
  sent settles, it asks `agent.running` again, in case those were lost.
- **Failures are reported, not thrown.** A method whose call to the host fails
  reports it through `Notify` rather than rejecting; `send` resolves false.
- **For a replacement.** The state it keeps is built with the contract's pure
  functions (`appendLog`, `resolveLeaf`, `trackTurn`, `newerQueue`, and
  `applyDelta`, `beginJoin`, `joinLive`, `reconcileLive` for `live`), which a
  replacement can reuse so the views read the same shapes.
