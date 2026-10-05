# @lemma/plugin-harness-acp

Runs Lemma turns on other coding agents through the [Agent Client
Protocol](https://agentclientprotocol.com) (ACP, v1): each configured agent is
a [harness](../harnesses/README.md) (plugin id `acp`). Requires `Harnesses`,
`Sessions`, `Interaction`, and `Paths`. Uses the official
`@agentclientprotocol/sdk`.

```sh
lemma harnesses                                   # which agents are ready
lemma run new --harness opencode "Fix the build"  # a session on OpenCode; its next turns stay there
```

## Config

| Key      | Default                             | Meaning                                                |
| -------- | ----------------------------------- | ------------------------------------------------------ |
| `agents` | Claude, Codex, OpenCode, Gemini CLI | The agents to offer. Setting it replaces the defaults. |

Each agent: `id` (the harness id: letters, digits, `-`, `_`), `command` (a name
on `PATH`, or a path) and `args` that start it speaking ACP on stdio, and
optionally `title`, `description`, `env` (on top of the host's), and `install`
(shown while the command is missing).

| Default    | Command                                               | Sign-in it uses                    |
| ---------- | ----------------------------------------------------- | ---------------------------------- |
| `claude`   | `npx -y @agentclientprotocol/claude-agent-acp@0.85.1` | Claude Code's (run `claude` once)  |
| `codex`    | `npx -y @agentclientprotocol/codex-acp@2.1.1`         | Codex's (`codex login`)            |
| `opencode` | `opencode acp`                                        | OpenCode's (`opencode auth login`) |
| `gemini`   | `gemini --acp`                                        | Gemini CLI's (run `gemini` once)   |

The Claude and Codex adapters are the official ones, pinned; `npx` downloads
each once into npm's cache, and each brings its agent (the Agent SDK, Codex).
Every agent runs on the sign-in its own CLI has, as it does in T3 Code. Mind
Anthropic's terms before offering Claude to other people on their Claude plan:
"Unless previously approved, Anthropic does not allow third party developers
to offer claude.ai login or rate limits for their products, including agents
built on the Claude Agent SDK" ([Agent SDK
overview](https://code.claude.com/docs/en/agent-sdk/overview)); an API key in
the agent's `env` (`ANTHROPIC_API_KEY`) is the sanctioned way.

## Behavior

- **Status.** An agent is `ready` when its command is an executable on `PATH`
  (or at its path); otherwise `unavailable`, saying how to install it.
  `lemma harnesses --refresh` asks again.
- **Process.** An agent's process starts with its first turn (in the host's
  directory), is `initialize`d with no file-system or terminal capabilities (the
  agent uses its own tools), and serves every session after it. One that exits
  is started again by the next turn; a turn running when it exits ends `error`
  with what it last printed to stderr. Processes stop with the plugin: stdin
  closed, then `SIGTERM`, then `SIGKILL`, two seconds apart.
- **Sessions.** Each turn logs a `custom` event (`acp.turn`: agent, ACP session
  id) before its prompts' answer. The next turn continues that ACP session when
  the branch's last turn ran in it and no later turn in it exists elsewhere in
  the log (a checkout to an earlier point leaves it behind): in the same
  process, or after a restart by `session/resume` (or `session/load`, whose
  replay is ignored) when the agent supports one. Otherwise a new ACP session
  starts, in the session's directory, and is first told the conversation so far
  as text (`transcript`); the marker records `handoffChars`.
- **What is logged.** Through `recordTurn`: message and thought chunks as text
  and thinking; each tool call under the agent's name for it (else its kind),
  with its title, input, and first location as arguments; a call's result when
  it completes or fails: its text and images, `Edited <path>` for a diff (the
  unified diff in `details.diff`, which the web app shows), or its raw output.
  The model is the session's `model` config option, when the agent reports one.
  Tokens come from the prompt response's `usage`; cost from `usage_update`'s
  running total in USD, the turn's share being what it grew by.
- **Permission.** `session/request_permission` becomes a `select` question to
  the session's clients ("OpenCode wants to Edit a.ts", with the agent's
  options and the call's input). Nobody answering, or a dismissal, is answered
  with the agent's refuse-once option.
- **Cancel.** Cancelling the turn sends `session/cancel`, answers open
  permission questions `cancelled`, and waits up to three seconds for the
  agent's response.
- **Stop reasons.** `end_turn` is `done`; `max_turn_requests` is `max-steps`;
  `max_tokens` and `refusal` are `error`; `cancelled` is `cancelled`.
- **Capabilities.** None: steers wait for the next turn, the agent picks its
  own model, and a turn a host restart cut off is closed as interrupted.
- **Inspector.** `acp.agents` shows each agent's command and process: running,
  the ACP sessions it has open, its version, or why it stopped.

Not yet: MCP servers for the agent (`session/new` sends none), model and mode
selection, plans, and slash commands the agent advertises.

## Testing

`acpPlugin({ start, status })` takes how an agent is started and checked;
the tests run scripted agents in-process (`acp.agent(...)` connected without a
process).
