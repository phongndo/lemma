# tools.delegate

The `delegate` tool: a task handed to an agent, a thread of its own that works
for this one. Adds it to `Tools`, and a section to the agent's
`PromptSections` naming the modes offered to agents and the thread's agents
still at work. Serves `delegate.stop` (below). It reaches the sessions store,
the agent, and the modes as a client does, through `sessions.*`, `agent.*`,
and `modes.list`. So it requires none of them, and a reload of any does not
restart it. Its web half (`./web`) shows agents in the chat, above the
composer, and in an agent's thread's header.

An agent is an ordinary session whose `SessionInfo.parent` names the thread
and the call that started it (`@lemma/sessions`). So the sidebar lists it under
that thread ([frame.sidebar](../../frame/sidebar/README.md)), and the person
can open it, read it whole, and write to it. Its name is its thread's title.

## The tool

`delegate { prompt, title?, mode?, model?, context?, background?, sessionId?, cwd? }`
resolves to `{ sessionId, title, ended, answer, error? }`. The model calls it
directly, and scripts (`codemode`) call it too; several calls in one response
run at once (`parallel`), `maxDelegations` at each depth.

| Input        | What it does                                                                                                                                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`     | The task, as the agent's first prompt: all a fresh agent knows of it                                                                                                                                                                                                                                                                                      |
| `title`      | The agent's name, its thread's title (default: the prompt's first line)                                                                                                                                                                                                                                                                                   |
| `mode`       | A mode offered to agents (`use: agent`, see [agent.modes](../../agent/modes/README.md)), with its model and thinking: `explore` ships for reading and reporting. Another is refused, naming those offered                                                                                                                                                 |
| `model`      | `provider/id`, over the mode's. Without either, the agent runs on the model and thinking of the calling thread's last turn                                                                                                                                                                                                                                |
| `context`    | `fresh` (default): the agent sees only the prompt. `fork`: it starts from the calling thread's finished turns (`sessions.fork` at its last `turn-end`: not the calling turn's work so far), in its mode, on its model, in its directory, so its requests extend the thread's and its cache serves them; it takes no `mode`, and no `cwd` but the thread's |
| `background` | Answer at once (`ended: "running"`); the thread is told when the agent finishes, below                                                                                                                                                                                                                                                                    |
| `sessionId`  | A follow-up: the prompt goes to an agent this thread started, steering it while it works; another thread's is refused. The agent keeps its own title, mode, model, context, and directory, so a follow-up given any of those inputs is refused, naming them                                                                                               |
| `cwd`        | The agent's directory, relative to the caller's (default: the caller's); one that is not a directory is refused before a session is made                                                                                                                                                                                                                  |

`ended` is the agent's turn's end (`done`, `error`, `cancelled`, `max-steps`),
`handled`/`refused` when a plugin answered its prompt itself, or `running` for
a background agent. Anything but `done` and `handled` is an error result that
still resolves in a script. The result's `details` (`DelegateDetails`) name
the agent for the views, with its answer's start (`preview`).

- **Run again, nothing twice.** The agent's prompt is sent with the request id
  `tools.delegate/<call id>`, and the call is `replay: "safe"`. Run again after
  a restart cut it off, it finds the agent its call started (by
  `SessionInfo.parent`, among the sessions in its directory) and waits on the
  same turn, which `agent.prompt` never places twice. A script's call has an
  id of its own (`<call>/<n>`), so a resumed script finds its agents too.
- **Depth from its own log.** A thread a person started is at depth 0, its
  agents at 1, theirs at 2. An agent's first turn logs its depth
  (`TurnOptions.plugins["tools.delegate"]`), so it counts from its own log,
  whatever became of the threads above it. A fork of an agent's thread counts
  from its copy. A follow-up counts no depth.
- **At `maxDepth`** an agent hands no task on. Its requests are not offered the
  tool (`AgentRequestHook`'s `select` phase), and a call that comes all the
  same (a script's) is refused.
- **Slots by depth.** `maxDelegations` agents work at once at each depth,
  counted apart, so an agent waiting on its own agents holds up only its own
  slot. Every thread on the host shares the slots. An agent holds its slot for
  its whole turn, so a long background agent keeps one from every other
  thread's agents at its depth. A follow-up takes none: its agent holds one
  while it works.
- **Made when its slot is free.** A waited-on agent is made once its slot is
  free, so a call stopped while it waits leaves nothing. A background one is
  made at once, to be named, and its prompt waits.
- **Cancelling.** Cancelling a waiting call (its turn is cancelled, or its
  script ends) cancels the agent's turn. A background agent works on until its
  row's Stop stops it (below).
- **Queued, not refused, when busy.** An agent's prompt that finds a turn
  running in it (a person wrote to it while it waited for a slot) waits for
  that turn to end (`whenBusy: "follow-up"`), so the task still runs.
- **Refused before it starts.** A call the person declines (`confirm`), a mode
  not offered, a `cwd` not there, or a prompt the agent refuses before placing
  it (an unknown model) leaves no agent behind: the session made for it is
  deleted. One that holds something by then (a person wrote to it while it
  waited) stays, and the call names it.

## Background agents

A background agent is kept as a file under `<home>/delegate/agents` from its
start until the thread it reports to has heard how it finished. The file holds
that thread, the agent's prompt and options, and the call. Its waiting is this
plugin's work (`PluginContext.background`). When its turn ends, a
`ModelNotice` from `tools.delegate`, its id the call's, tells the thread. The
agent places it as a `context` event, steering a running turn, or starting one
after a turn that ran to its end:

```
<agent_result title="Map callers of rebuildRequest" session="…" ended="done">
…its answer…
</agent_result>
```

An answer longer than a result's default budget (`DEFAULT_MAX_RESULT_CHARS` in
`@lemma/tools`) keeps its start and its end there, the whole in a temp file the
model can read.

- **Until it is heard.** The file goes once the thread logged the notice
  (`SessionAppended`). Until then the notice is published again every 15
  seconds, since one no agent hears (as while one reloads) is lost, and the
  agent places an id once.
- **After a reload or restart**, the plugin waits on each kept agent again, and
  places its prompt if it never was. One whose log has it takes no slot: its
  turn runs on its own. A thread that heard already is not told twice, and one
  deleted is told nothing.
- **An agent whose thread is deleted** as its turn ends still ends, as an
  error, and its thread is told so. One whose ending cannot be read otherwise
  is kept, and waited on again after a restart.

`delegate.stop { sessionId }` (an agent's row's Stop) stops an agent as it is,
and answers which way it did:

- `dropped`: it waited for a slot. Its prompt is never placed, and its thread
  is deleted unless something was written to it meanwhile. The thread it
  reports to is told it was stopped (`ended="cancelled"`).
- `withdrawn`: its prompt waited behind another turn (a person's, a
  follow-up's), and is withdrawn (`agent.withdraw`), so that turn runs on.
- `cancelled`: its turn is cancelled.

The `tools.delegate.agents` section, in a request that offers the tool, lists
the modes offered to agents in the thread's directory, and the thread's
background agents at work. So a turn that compacted its history away still
knows of them. It goes once a request's tools are chosen without the tool
(`AgentRequestHook`'s `select` phase), so a mode without it (`explore`) is told
nothing of agents.

## Config

| Key              | Default | What it does                                                                                       |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `maxDelegations` | `4`     | Agents working at once at each depth, across every thread on the host; more wait for one to finish |
| `maxDepth`       | `1`     | How deep delegations go: an agent this many levels down hands no task on; `0`: off                 |
| `confirm`        | `false` | Ask the person before each new agent                                                               |

## In the web app

An agent shows as its picture (its session id's identicon, the look's
`AvatarPart`), its name, and its state: Queued, Working, Needs input,
Finished, Failed, or Stopped. Pressing it opens the agent's thread. Queued
means its prompt waits for a slot. A background agent is queued while its log
holds no more than its call made (the result's `details.emptyAt`).

- **In the chat**, a delegating call shows its agent where the turn's displays
  go, kept current while it works (`ToolView.live`). Several in a row show as
  one line ("3 agents · 2 working") that opens to each (`ToolView.displays`).
- **A finished background agent's notice** shows as the agent where its thread
  heard it (`ContextViews`).
- **Stop** shows on an agent at work, or a queued background one. It calls
  `delegate.stop`, or `agent.cancel` with no host half to serve it.
- **Above the composer**, while the thread's agents work: their pictures, and
  how long they have worked ("Waiting on 2 agents" once the thread is idle).
- **An agent's thread's header** names the thread it works for, and goes back
  to it.

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
