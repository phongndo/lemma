# tools.delegate

The `delegate` tool: a task handed to an agent, a thread of its own that works
for this one. Adds it to `Tools`, and a section to the agent's
`PromptSections` naming the modes offered to agents and the thread's agents
still at work; requires `Interaction` (to ask first, when configured) and
`Paths` (where background agents are kept). It reaches the sessions store, the
agent, and the modes as a client does, through `sessions.*`, `agent.*`, and
`modes.list`, so it requires none of them, and a reload of any does not
restart it. Its web half (`./web`) shows agents in the chat, in the thread
card's lineage, and above the composer.

An agent is an ordinary session whose `SessionInfo.parent` names the thread
and the call that started it (`@lemma/sessions`), so the sidebar lists it under
that thread ([frame.sidebar](../../frame/sidebar/README.md)), and the person
can open it, read it whole, and write to it themselves. Its name is its
thread's title.

## The tool

`delegate { prompt, title?, mode?, model?, context?, background?, sessionId?, cwd?, timeoutMs? }`
resolves to `{ sessionId, title, ended, answer, error? }`. The model calls it
directly, and scripts (`codemode`) call it too; several calls in one response
run at once (`parallel`), `maxDelegations` at each depth.

| Input        | What it does                                                                                                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`     | The task, as the agent's first prompt: all a fresh agent knows of it                                                                                                                                                                                                                                                  |
| `title`      | The agent's name, its thread's title (default: the prompt's first line)                                                                                                                                                                                                                                               |
| `mode`       | A mode offered to agents (`use: agent`, see [agent.modes](../../agent/modes/README.md)), with its model and thinking: `explore` ships for reading and reporting. Another is refused, naming those offered                                                                                                             |
| `model`      | `provider/id`, over the mode's. Without either, the agent runs on the model and thinking of the calling thread's last turn                                                                                                                                                                                            |
| `context`    | `fresh` (default): the agent sees only the prompt. `fork`: it starts from the calling thread's finished turns (`sessions.fork` at its last `turn-end`), in its mode, on its model, in its directory, so its requests extend the thread's and its cache serves them; it takes no `mode`, and no `cwd` but the thread's |
| `background` | Answer at once (`ended: "running"`); the thread is told when the agent finishes, below                                                                                                                                                                                                                                |
| `sessionId`  | A follow-up: the prompt goes to an agent this thread started, steering it while it works; another thread's is refused                                                                                                                                                                                                 |
| `cwd`        | The agent's directory (default: the caller's); one that is not a directory is refused before a session is made                                                                                                                                                                                                        |
| `timeoutMs`  | How long the agent may take, from when it has a slot (a background agent's, from the call); past it, its turn is cancelled, or its prompt never placed, and `ended` is `timeout`                                                                                                                                      |

`ended` is the agent's turn's end (`done`, `error`, `cancelled`, `max-steps`),
`timeout`, `handled`/`refused` when a plugin answered its prompt itself, or
`running` for a background agent. Anything but `done` and `handled` is an
error result that still resolves in a script. The result's `details`
(`DelegateDetails`) name the agent for the views, with its answer's start
(`preview`).

- **Run again, nothing twice.** The agent's prompt is sent with the request id
  `tools.delegate/<call id>`, and the call is `replay: "safe"`: run again after
  a restart cut it off, it finds the agent its call started (by
  `SessionInfo.parent`, among the sessions in its directory) and waits on the
  same turn, which `agent.prompt` never places twice. A script's call has an
  id of its own (`<call>/<n>`), so a resumed script finds its agents too.
- **Depth from its own log.** A thread a person started is at depth 0, its
  agents at 1, theirs at 2: an agent's first turn logs its depth
  (`TurnOptions.plugins["tools.delegate"]`), so it counts from its own log,
  whatever became of the threads above it, and a fork of an agent's thread
  counts from its copy. An agent at `maxDepth` hands no task on (the tool
  says so), and a follow-up counts no depth.
- **Slots by depth.** `maxDelegations` agents work at once at each depth,
  counted apart, so an agent waiting on its own agents holds up no one's slot
  but its own. A waited-on agent is made once its slot is free, so a call
  stopped while it waits leaves nothing; a background one is made at once, to
  be named, and its prompt waits. A follow-up takes none: its agent holds one
  while it works.
- **Cancelling.** Cancelling a waiting call (the turn calling it is cancelled,
  or its script ends) cancels the agent's turn. A background agent works on:
  its thread's lineage stops it.
- **Refused before it starts.** One the person declines (`confirm`), a mode not
  offered, a `cwd` not there, or a prompt the agent refuses before placing it
  (an unknown model): no agent is left behind, as the session made for it,
  holding nothing since, is deleted. One that holds something by then (a
  person wrote to it while it waited) stays, and the call names it.

## Background agents

A background agent is kept as a file under `<home>/delegate/agents` (the
thread it reports to, its prompt and options, the call) from its start until
that thread has heard how it finished. Its waiting is this plugin's work
(`PluginContext.background`): when its turn ends, a `ModelNotice` from
`tools.delegate`, its id the call's, tells the thread, which the agent places
as a `context` event (steering a running turn, or starting one after a turn
that ran to its end):

```
<agent_result title="Map callers of rebuildRequest" session="…" ended="done">
…its answer, cut to maxOutputChars…
</agent_result>
```

Once the thread logged it (`SessionAppended`), the file goes; until then the
notice is published again every 15 seconds, since one no agent hears (as
while one reloads) is lost, and the agent places an id once. A reload or a
restart waits on each kept agent again, placing its prompt if it never was,
unless its `timeoutMs` ran out first; a thread that heard already is not told
twice, and one deleted is told nothing. Its agents work on, threads of their
own.

The `tools.delegate.agents` section, in a request that offers the tool, lists
the modes offered to agents in the thread's directory, and the thread's
background agents at work, so a turn that compacted its history away still
knows of them. Written before a request's tools are chosen, it goes once they
are without the tool (`AgentRequestHook`'s `select` phase), so a mode without
it (`explore`) is told nothing of agents.

## Config

| Key              | Default | What it does                                                                          |
| ---------------- | ------- | ------------------------------------------------------------------------------------- |
| `maxDelegations` | `4`     | Agents working at once at each depth; more wait for one to finish                     |
| `maxDepth`       | `2`     | How deep delegations go: an agent this many levels down hands no task on; `0`: off    |
| `confirm`        | `false` | Ask the person before each new agent                                                  |
| `maxOutputChars` | `20000` | Characters of an agent's answer the model reads; the rest stays in the agent's thread |

## In the web app

An agent shows as its picture (its session id's identicon, the look's
`AvatarPart`) with a dot for what it is doing, its name, how it is doing
(Queued, Working, Needs input, Finished, Failed, Stopped), a line of what it
said, its time, and a chevron; pressing it opens the agent's thread. Queued
is an agent whose prompt waits for a slot: a waited-on call's before it has
one, or a background agent whose log holds no more than its call made (the
result's `details.emptyAt`).

- **In the chat.** A delegating call shows its agent where the turn's displays
  go, after its folded work, kept current while it works (`ToolView.live`);
  several in a row show as one line, "3 agents · 2 working", which opens to
  each (`ToolView.displays`), a script's too. A finished background agent's
  notice shows as the agent, finished, failed, or stopped
  (`ContextViews`), where its thread heard it.
- **The thread card's lineage**, at the card's bottom: the thread an agent
  works for (one press goes back), its agents at work, each with Stop, and
  those that finished folded under "Previous agents"; its menu stops those at
  work and archives those done.
- **Above the composer**, while the thread's agents work: their pictures, each
  opening its agent, and how long they have worked ("Waiting on 2 agents"
  once the thread itself is idle).
- **An agent's thread's header** names the thread it works for, before its
  title, one press going back.

## Rationale

- **An agent is a thread.** Not a hidden process: a session the person can
  open, read, and steer, listed under the thread it works for, kept and
  searched as any thread is. Its own log is its truth, rebuildable as any
  session's; the calling thread logs only what it asked and what it heard.
- **Waited on, or told.** A short task is waited on, its answer the call's
  result. A long one goes to the background, and the thread is told when it
  finishes rather than polling; a notice never interrupts a turn's tools, it
  joins after the current step. Kept as a file until heard, so a restart
  loses no answer.
- **A tool of its own, declared.** Handing on work is a model's own decision,
  so the model is sent the tool, not only scripts; a mode that should not
  delegate leaves it out (`explore` does), and `maxDepth` bounds the rest.
- **Modes, not agent kinds.** An agent's mode is the same Markdown file a
  thread's mode is, with `use: agent`, so a kind of agent of a user's own is a
  file, not a plugin.
- **Names are titles, pictures are identicons.** An agent needs nothing chosen
  or stored to be told apart: its title says what it does, and its picture is
  drawn from its id, as GitHub draws a new account's.
