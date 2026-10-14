# agent.acp

Runs a thread's turns on other coding agents over the [Agent Client Protocol](https://agentclientprotocol.com): Claude Code, Codex, Gemini CLI, OpenCode, pi, and any agent that speaks it. Adds each enabled agent to the agent's `Harnesses` (`@lemma/agent`), serves them to clients as the `acp.*` channels (`AcpChannels`, `@lemma/agent/acp`), and draws them in Settings › Integrations in its web half, with how the chat shows their tool calls and their permission requests. Requires `Paths`.

## Use

Pick one of an agent's models in the composer's model control, whose rail lists Lemma and each agent by its mark, and the thread's next turn runs on that agent and model. Lemma keeps the thread: its log, its queue, cancelling, and the transcript work as they do for its own turns ([agent.loop](../loop/README.md#other-harnesses)). The agent works in the thread's folder with its own tools, as it does in a terminal.

Beside it, the access level says how much the agent may do without asking:

| Level             | Claude Code         | Codex                 | An agent with no modes                   |
| ----------------- | ------------------- | --------------------- | ---------------------------------------- |
| Supervised        | `default` (Manual)  | `read-only`           | every request is asked                   |
| Auto-accept edits | `acceptEdits`       | `workspace-write`     | Lemma allows file changes, asks the rest |
| Auto              | `auto`              | `agent` (Auto review) | not offered: only the agent can judge    |
| Full access       | `bypassPermissions` | `agent-full-access`   | Lemma allows every request               |

Lemma puts the session in the agent's own mode for the level ([`access.ts`](src/access.ts) maps the ids agents use), and answers the requests the agent still makes as the level says. A request it does not answer itself takes over the thread's composer, as t3code's do: what the agent wants to do (its command, or the changes, as a diff), Approve as the send button (Enter), and Decline and the agent's other choices beside it. Clients follow `acp.permissions` and answer with `acp.respond`; with none following, a request waits `waitForClientMs` and is refused. A turn the prompt names no level for, or a level the agent has no mode for, puts the session back in the agent's mode for asking (Supervised's), so a level chosen earlier never outlasts a lower one; with no level, every request is asked.

None is added at first. Settings › Integrations › + lists these, which Lemma supports, then the rest of the ACP Registry's agents, each added by picking it, and run when first used; `Custom agent…` adds any other by its command:

| Id         | Agent       | Runs                                                        | Signs in                                |
| ---------- | ----------- | ----------------------------------------------------------- | --------------------------------------- |
| `claude`   | Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.90.0`       | `claude` once, or `ANTHROPIC_API_KEY`   |
| `codex`    | Codex       | `npx -y @agentclientprotocol/codex-acp@2.2.2`               | `codex login` once, or `OPENAI_API_KEY` |
| `gemini`   | Gemini CLI  | `npx -y @google/gemini-cli@0.63.0 --acp`                    | `gemini` once, or `GEMINI_API_KEY`      |
| `opencode` | OpenCode    | `opencode acp`, which needs `opencode` on the host's PATH   | `opencode auth login`                   |
| `pi`       | Pi          | `npx -y pi-acp@0.0.34`, which needs `pi` on the host's PATH | `pi`, once                              |

The versions are the [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)'s as of 2026-10-13 ([`presets.ts`](src/presets.ts)).

`~/.lemma/agents.json` (`<Paths.home>/agents.json`) holds the agents added, by id: a supported agent's id adds it (an empty entry takes it as Lemma knows it; fields change it), and any other id adds an agent of its own. Settings › Integrations writes it, and an edit in an editor applies when it is saved:

```json
{
  "agents": {
    "gemini": {},
    "claude": { "env": { "ANTHROPIC_API_KEY": "sk-…" } },
    "qwen-code": { "title": "Qwen Code", "command": "npx", "args": ["-y", "@qwen-code/qwen-code@0.9.1", "--acp"] }
  }
}
```

| Field                         | Meaning                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`             | Starts it speaking ACP over stdin and stdout, resolved on the host's PATH. Over a built-in one, replaces its command line |
| `env`                         | Added to the host's environment for it                                                                                    |
| `title`, `description`        | How it is named in the composer and Integrations                                                                          |
| `enabled`                     | `false` keeps the entry without offering the agent                                                                        |
| `mcp`                         | `false`: it is not handed Lemma's MCP servers                                                                             |
| `icon`                        | An image's address (`https:`, or a `data:image/` URL) drawn as its mark, over the one Lemma or the registry gives it      |
| `install`, `docs`, `registry` | What Integrations shows while it cannot run, its documentation, and the registry entry it was added from                  |

An id is lowercase letters, digits, `_`, and `-`, and never `lemma`: the log names each turn's harness by it.

| Config            | Default | Meaning                                                                                                   |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `registry`        | `true`  | When adding an agent, list those the ACP Registry offers through npx or uvx, read from its CDN when asked |
| `waitForClientMs` | `15000` | With nobody following the agents' permission requests as one is made, how long to wait before refusing it |

## Behavior

- **Status.** An agent is ready while its command, and any it runs itself (pi-acp runs `pi`), are on the host's PATH; `acp.check` starts it, opens a session it asks nothing in to read its modes and models, and reports what it says it is and how it signs in.
- **Models and marks.** An agent's models are its `model` config option, read from its sessions and set per turn with `session/set_config_option`; the built-in ones carry the registry's marks (Claude's in its color), one added from the registry its icon, read from the registry's CDN by the host, and any its own `icon`.
- **Silent turns.** A turn an agent ends without saying or doing anything fails, saying the agent may need signing in: an agent that cannot reach its model can end its turn as if done (pi-acp does). A turn that needs signing in fails and says so; `acp.authenticate` signs in with one of the agent's own methods (an agent that signs in in a terminal says the command instead).
- **Processes.** Each agent's process starts with its first turn, or a check, and serves every thread that runs on it, each in an ACP session of its own. A change to its command line or environment stops it; the next turn starts it again.
- **Threads.** A thread's ACP session is logged with its turns (`agent.harness-state`). The next turn continues it, sent what was said on the thread since (turns other harnesses ran); after a restart the agent takes it up again if it can resume sessions, and otherwise opens a new one, sent the whole conversation as text (`transcript`). A branch left after the agent ran on another one opens a new one too: the agent's session holds that branch's turns. A thread deleted cancels and forgets its sessions.
- **MCP servers.** Each session is handed the servers `mcp.servers` offers other agents (`McpLaunches`: every enabled one not kept from them): local ones always, remote ones when the agent takes them. ACP gives a server no folder, so one with a `cwd` starts through `/bin/sh`, which changes to it first.
- **Calls.** The agent's tool calls are logged under `acp.<kind>` (`acp.execute`, `acp.edit`, `acp.read`…), their arguments the call's `title`, its raw `input`, and the files it touches; a call's result is logged when it completes or fails, its diffs in `details`. The web half shows each kind with its own icon and title.
- **Limits.** Lemma offers the agent no file system or terminal of its own: it uses its tools on the host. Images in a prompt reach an agent that takes them. A turn a crash cut off is not resumed. Agents the registry ships as binaries are not offered from it yet; add one by its command.

## Rationale

- **ACP, not each agent's own SDK.** One protocol reaches every agent that speaks it, which Zed and JetBrains also drive, and the adapters keep up with their agents.
- **The agent's log is Lemma's.** Writing another agent's turn as the session's own events keeps the log the one record of a thread, whatever ran it, so the views, the CLI, and a handoff to another harness read it the same way.
- **A file of its own.** As `mcp.json` does, `agents.json` keeps per-agent settings out of this plugin's config row, which a project's would replace whole, and is easy to write from the settings page.
