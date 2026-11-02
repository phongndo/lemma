# tools.lemma

Lemma itself, as tools scripts call: the channels its plugins serve clients
(the web app, the `lemma` command) become `lemma_*` tools in the `lemma`
namespace. Adds them to `Tools`, and the namespace to `ToolNamespaces`. The
tools are `nested`: while `codemode` is offered, scripts find them
(`await searchTools("lemma sessions")`, `await describeNamespace("lemma")`)
rather than every request declaring them.

## Channels as tools

A channel `<domain>.<name>` is the tool `lemma_<domain>_<name>`, `.` and `-`
as `_` (`sessions.set-title` is `lemma_sessions_set_title`). Its input is the
channel's payload as JSON, the JSON a client sends (`lemma channels call`),
and its result is the result's JSON: whole as what a script's call resolves to
(`structured`), and as text the model reads, its start and end past the call's
budget (`tools.registry`'s `maxResultChars`) with the whole in a temp file.

| Channel takes                                              | The tool takes                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| An object, or one a client may leave out (`sessions.list`) | That object (`{}` for none)                                                        |
| No payload (`agent.running`)                               | `{}`                                                                               |
| Anything else (a string, a list)                           | `{ payload }`                                                                      |
| A stream (`agent.activity`)                                | `{ payload?, take?, timeoutMs? }`, and resolves to `{ elements, ended, timedOut }` |

A stream's tool opens it and collects elements until `take` have come (default
1, at most 1,000), it ends (`ended`), or `timeoutMs` passes (default 10
seconds, at most 10 minutes; `timedOut`). Then it closes the stream. Most
streams begin with a `subscribed` element.

- **Tools follow the channels.** One turned off takes its tool with it, one
  turned on adds its tool, and one a plugin replaces is offered as its
  replacement declares it.
- **Left out.** A channel whose payload or result holds a declared type with no
  JSON codec (a `Schema.declare` of a `Map`, say) is left out, and the host
  warns of it once. One the tools registry cannot otherwise render as JSON
  Schema is left out of its list when the tools are first listed, with one
  warning too ([tools.registry](../registry/README.md)).
- **Calls** go to whatever answers for the id when they run, as a client's do.
  One marked `repeatable` is made again on a replacement when a reload
  withdraws it. A call that fails names the channel and the code
  (`"sessions.get" failed (NotFound): …`).

## Config

| Key        | Default                 | What it does                                                                                  |
| ---------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `channels` | `["*"]`                 | Channel ids offered as tools, called freely; `*` is every channel that declares it only reads |
| `confirm`  | the writing list, below | Channel ids offered as tools whose every call asks the person first, showing the payload      |

A channel says what calling it does (`access` in its declaration): `read`,
`operate`, `change`, or `secret`. By default `channels` holds `*`: every
channel that declares `read`, whatever plugin serves it. So a plugin's new
read is a script's new tool with nothing configured. That covers sessions and
their Trajectory views (`sessions.list`, `.events`, `.search`, `.records`,
`.request`, `.cache`), the agent's state, what else Lemma has (commands,
skills, modes, models), the workspace, and the host's own state and trace
(`devtools.host.*`, `devtools.trace.*`). It stays an allowlist: without `*` it
offers only the ids it names, and an id beside `*` adds a channel that
declares nothing. A channel that declares a write (`operate`, `change`) asks
first even when `channels` names it. `confirm` takes precedence over both.

By default `confirm` holds the changes an agent may usefully make:

- prompting, cancelling, withdrawing, and promoting (`agent.prompt`,
  `.cancel`, `.withdraw`, `.promote`);
- making, renaming, filing, checking out, and forking sessions
  (`sessions.create`, `.set-title`, `.mark`, `.checkout`, `.fork`);
- running a command (`commands.run`);
- the workspace's writes (`workspace.create-directory`, `.create-worktree`,
  `.remove-worktree`, `.restore-worktree`, `.checkout`);
- reconnecting an MCP server and starting its sign-in (`mcp.reconnect`, and
  `mcp.sign-in`, which answers with the page the person approves in a
  browser).

A declined question, a dismissed one, or nobody to ask leaves the channel
uncalled. The call is then an error saying which.

Never offered to the agent, whatever the config says: a channel that declares
`secret` (a credential can cross it), and these, even when a replacement
declares less:

- signing in to a provider and out (`llm.login`, `llm.sign-ins`,
  `llm.answer-sign-in`, `llm.logout`, `llm.cancel-login`);
- finishing an MCP server's sign-in (`mcp.finish-sign-in`), whose address
  carries the server's authorization code;
- the provider and server entries that can hold a credential
  (`llm.add-custom`, `llm.remove-custom`, `llm.set-logo`, `mcp.put`), and
  their state as written (`mcp.state`, `mcp.changes`, where a credential may
  be typed in place of a `${VAR}`; `mcp.list` reads the servers' states
  without it);
- `cli.run`, which runs any `lemma` command, those among them.

`commands.run` can run a command that logs out of a provider; its question
shows the command's id.

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
