# tools.lemma

Lemma itself, as tools scripts call: the channels its plugins serve clients
(the web app, the `lemma` command) become `lemma_*` tools in the `lemma`
namespace, and `lemma_delegate` hands a task to a new session. Adds them to
`Tools`, and the namespace to `ToolNamespaces`; requires `Interaction`, which
asks the person before a call that changes something. The tools are `nested`:
while `codemode` is offered, scripts find them (`await searchTools("lemma
sessions")`, `await describeNamespace("lemma")`) rather than every request
declaring them.

## Channels as tools

A channel `<domain>.<name>` is the tool `lemma_<domain>_<name>`, `.` and `-`
as `_` (`sessions.set-title` is `lemma_sessions_set_title`). Its input is the
channel's payload as JSON, the JSON a client sends (`lemma channels call`),
and its result is the result's JSON: whole as what a script's call resolves to
(`structured`), and as text the model reads, cut to `maxOutputChars` with the
rest in a temp file.

| Channel takes                                              | The tool takes                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| An object, or one a client may leave out (`sessions.list`) | That object (`{}` for none)                                                        |
| No payload (`agent.running`)                               | `{}`                                                                               |
| Anything else (a string, a list)                           | `{ payload }`                                                                      |
| A stream (`agent.activity`)                                | `{ payload?, take?, timeoutMs? }`, and resolves to `{ elements, ended, timedOut }` |

A stream's tool opens it, collects elements until `take` have come (default
1, at most 1,000), it ends (`ended`), or `timeoutMs` passes (default 10
seconds, at most 10 minutes; `timedOut`), and closes it. Most streams begin
with a `subscribed` element. Tools follow the channels: one turned off takes
its tool with it, one turned on adds its tool, and one a plugin replaces is
offered as its replacement declares it. One whose payload or result holds a
declared type with no JSON codec (a `Schema.declare` of a `Map`, say), which no
JSON decodes to, is left out, and the host warns of it once. A call is made to whatever answers for
the id when it runs, as a client's is, and one marked `repeatable` is made
again on a replacement when a reload withdraws it. A call that fails says the
channel and the code (`"sessions.get" failed (NotFound): …`).

## Config

| Key                 | Default                 | What it does                                                                                                 |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `channels`          | `["*"]`                 | Channel ids offered as tools, called freely; `*` is every channel that declares it only reads                |
| `confirm`           | the writing list, below | Channel ids offered as tools whose every call asks the person first, showing the payload                     |
| `maxDelegations`    | `4`                     | `lemma_delegate` sessions running at once at each depth; more wait for one to end                            |
| `maxDepth`          | `2`                     | How deep delegations go: a delegated session this many levels down cannot delegate; `0`: no `lemma_delegate` |
| `confirmDelegation` | `false`                 | Ask the person before each `lemma_delegate`                                                                  |
| `maxOutputChars`    | `20000`                 | Text characters of a result the model reads when it calls a tool directly                                    |

A channel says what calling it does (`access` in its declaration): `read`,
`operate`, `change`, or `secret`. `channels` holds `*` by default, every
channel that declares `read`, whatever plugin serves it, so a plugin's new
read is a script's new tool with nothing configured: sessions and their
Trajectory views (`sessions.list`, `.events`, `.search`, `.records`,
`.request`, `.cache`), the agent's state, what else Lemma has (commands,
skills, profiles, models), the workspace, and the host's own state and trace
(`devtools.host.*`, `devtools.trace.*`). It stays an allowlist: one without
`*` offers only the ids it names, and an id beside `*` adds a channel that
declares nothing. A channel that declares a write (`operate`, `change`)
asks first even when `channels` names it; `confirm` takes precedence over
both.

`confirm` by default holds those that change something an agent may usefully
do: prompting, cancelling, withdrawing, and promoting (`agent.prompt`,
`.cancel`, `.withdraw`, `.promote`), making, renaming, filing, checking out,
and forking sessions (`sessions.create`, `.set-title`, `.mark`, `.checkout`,
`.fork`), running a
command (`commands.run`), the workspace's writes
(`workspace.create-directory`, `.create-worktree`, `.checkout`), and
`mcp.reconnect`. A declined question, a dismissed one, or nobody to ask
leaves the channel uncalled, and the call is an error saying which.

Never offered, whatever the config says: a channel that declares `secret`
(a credential can cross it), and, even when a replacement declares less,
signing in and out (`llm.login`, `llm.logout`, `llm.cancel-login`), the
provider and server entries that can hold a credential (`llm.add-custom`,
`llm.remove-custom`, `llm.set-logo`, `mcp.put`), their state as written
(`mcp.state`, `mcp.changes`, where a credential may be typed in place of a
`${VAR}`), and `cli.run`, which runs any `lemma` command, those among them.
`commands.run` can run a command that logs out of a
provider; its question shows the command's id.

## Delegation

`lemma_delegate { prompt, title?, cwd?, model?, timeoutMs? }` creates a session
(in the caller's directory unless `cwd` says), titles it (the prompt's first
line by default), sends the prompt (`agent.prompt`), and waits for the turn it
starts to end. It resolves to `{ sessionId, ended, answer, error? }`: `ended`
is the turn's end (`done`, `error`, `cancelled`, `max-steps`), `timeout`, or
`handled`/`refused` when a plugin answered the prompt itself; `answer` is the
turn's last reply. Anything but `done` is an error result that still resolves
in a script, which reads `ended`. A delegation that never starts rejects
instead, and leaves no session behind: one at `maxDepth`, one the person
declines, a `cwd` that is not a directory on the host, or a prompt the agent
refuses before placing it (an unknown model), whose empty session is deleted.
A script fans out with `Promise.all`; beyond `maxDelegations` the rest wait.
The new session sees only the prompt.

- **Cancelling.** Cancelling the call (the turn calling it is cancelled, or
  its script ends) cancels the delegated turn; so does `timeoutMs` passing.
- **Depth.** The prompt is sent with the request id
  `tools.lemma/delegate/<depth>/<uuid>`, which the session's log keeps on its
  user message. A session's depth is what its first prompt's id says, 0 for
  one a person started, so a delegate's own delegations count from its log,
  across restarts, with nothing else written; at `maxDepth` it is refused.
- **Slots by depth.** `maxDelegations` counts each depth's delegations apart
  (those people's sessions start, those their delegates start, …), so at most
  `maxDelegations` × `maxDepth` run at once. A delegation keeps its slot until
  its turn ends, which waits on the delegate's own delegations: with one count
  for all, parents holding every slot would wait for ever on children waiting
  for one.
- **Through channels.** It reaches the agent and the sessions store as a
  client does, through `sessions.*` and `agent.*`, so it requires neither, a
  reload of either does not restart it, and `agent.prompt`, `repeatable` by its
  request id, is made again on the agent's replacement without placing the
  prompt twice.

## Rationale

- **What a person can do, an agent can reach.** T3 Code holds that a
  capability a user can trigger should be one an agent reaches, through the
  same service the UI calls. In Lemma that layer is the channels: every domain
  serves its own calls to clients as channels, each declaring its id,
  description, and payload and result schemas. Offering them as tools needs
  nothing of any domain, and a plugin's new channel is a script's new tool.
- **Nested, so the prompt stays small.** Dozens of channels would cost every
  request their declarations and change its tool list as plugins come and go,
  invalidating its cache. Scripts search for them instead, and read the
  namespace's instructions once.
- **Reads free, writes asked.** Reading Lemma's state is what an agent needs
  most and risks nothing a session's own tools do not; changing it (a prompt
  that spends money, a checkout that moves a session) is the person's to
  allow, call by call. Credentials never cross.
- **The channel says what it does.** Whether a call only reads is a fact
  about the channel, which its author knows, so its declaration says it and
  every read is offered as it comes. Which writes are worth an agent's asking
  is a judgment, so the config names them.
- **Delegation is a tool, not a channel.** Waiting for a turn to end and
  reading its answer is several calls and a projection of the log; scripts
  get one call that resolves to the answer, which `Promise.all` fans out.
