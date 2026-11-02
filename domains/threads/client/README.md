# threads.client

Keeps the web app's threads in step with the host: the list of threads, the
open one's log and what streams into it, which threads run, what each asks of
the person, and sending prompts. It provides `Threads`
([`@lemma/threads`](../contract/src/threads.ts)), which the domain's other
plugins read. It follows the `sessions.changes` and `agent.activity` channels,
and the open thread's `sessions.log` and `agent.output`. It adds
`threads.running` to `PluginsFacts`: how many turns run, since the Plugins
page's reload restarts host plugins mid-turn. No config.

## Behavior

- **The address names the open thread** (`/threads/<id>`, `ThreadRoute`), so a
  link, back and forward, and a reload open it. A deleted thread's address goes
  to the new-thread page (`/`).
- **Threads exist before their first prompt**, as a browser's tabs do.
  `newThread` goes to this tab's empty thread in the directory, if it has one,
  so there is one new thread per directory.
- **A tab's blank threads are its own** (`lemma.threads.client.made`, in the
  tab's storage). One left with nothing kept for it (no draft, no `ThreadHolds`
  item) is deleted. One with something kept for it is marked `kept` on the host,
  so the host's sweep of empty sessions passes it over.
- **Drafts.** `drafts` is the one place unsent prompts are kept, the
  new-thread page's under `""`. Their text is kept in the browser
  (`lemma.threads.client.drafts`) and merged across tabs. Their images last
  while the page does.
- **Only the open thread is followed.** `agent.activity` is opened without
  output, so threads streaming in the background cost the page their turns'
  starts and ends, not every delta. A log `preload` fetched is used if its
  thread opens within 15 seconds.
- **Streaming** deltas are applied once per animation frame, or at once when
  256 are waiting, since a hidden tab gets no frames.
- **Attention** (`attention`) is one record per thread, so the sidebar and
  notifications agree. A turn's end stays unseen until its thread shows in a
  focused window, or `markSeen`. Unseen ends are kept in the browser
  (`lemma.threads.client.unseen`) and shared across tabs.
- **Failures are reported, not thrown.** A method whose call to the host fails
  reports it through `Notify`; `send` resolves false.
- **For a replacement.** The contract's pure functions build the state it
  keeps, so a replacement's views read the same shapes: `appendLog`,
  `resolveLeaf`, `trackTurn`, `newerQueue`, `applyDelta`, `joinLive`,
  `reconcileLive`, `noteLogged`, `noteEnded`, `attentionOf`, and `tells`.
