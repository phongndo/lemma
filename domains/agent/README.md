# agent

The agent: the turn loop that asks a model, runs the tools it calls, and logs each step to the session; and the harnesses a turn can run on instead, other coding agents driven over the Agent Client Protocol. Its contract is [`@lemma/agent`](contract/src/agent.ts), with the harnesses in [`harness.ts`](contract/src/harness.ts) and the ACP agents' channels in [`@lemma/agent/acp`](contract/src/acp.ts).

| Plugin                                    | Halves     | What it does                                                                                                                                                |
| ----------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agent.loop`](loop/README.md)            | host       | Runs turns: provides `Agent`, and serves it to clients as the `agent.*` channels; runs a turn on another harness when it names one                          |
| [`agent.cli`](cli/README.md)              | host       | The `lemma` command's `run` and `agent …`: adds them to `CliCommands`                                                                                       |
| [`agent.acp`](acp/README.md)              | host + web | Adds the agents in `~/.lemma/agents.json` (Claude Code, Codex, Gemini CLI, OpenCode, pi, or any that speaks ACP) to `Harnesses`; their part of Integrations |
| [`agent.harness-picker`](harness-picker/) | web        | The composer's agent picker, and the agent new threads start on                                                                                             |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `PromptSections`: a section of the system prompt, written for each request, in the phase `body`, between the agent's base (`base`) and environment (`environment`); `Harnesses`: another coding agent a turn can run on, with its mark (`HarnessLogo`), its models and access levels (`Access`), which reports what it did as `HarnessUpdate`s |
| Intercept | `AgentInputHook`: a prompt before it is placed (rewrite it, handle it, or refuse it); `AgentRequestHook`: a request before it is logged and sent (its sections, tools, model), in the phase `shape`, or `fit` to see what every other made; `AgentContinueHook`: whether a turn takes another step                                             |
| Observe   | `TurnStarted`, `TurnEnded`, `QueueChanged`, `AssistantDelta`; `HarnessStatusChanged`: a harness's status changed (its plugin publishes it)                                                                                                                                                                                                     |
| Call      | `Agent`: prompt (answering with its `PromptOutcome`), cancel, the queue (withdraw a prompt, or promote a follow-up to a steer), a session's live view; clients call `AgentChannels`, and `HarnessChannels` for the harnesses and their status                                                                                                  |
| Serve     | `Agent`, with `serveAgent` and `serveHarnesses` for its channels: a plugin providing it replaces `agent.loop`                                                                                                                                                                                                                                  |

## Harnesses

A turn runs on the harness its prompt names (`TurnOptions.harness`), else `agent.loop`'s `defaultHarness`, else the agent's own loop (`lemma`). The agent keeps everything around the turn whichever runs it: the queue, exactly-once submission, cancelling, the live view, and the log, where it writes what the harness reports in the shape of its own turns, so the transcript, the trajectory, and the CLI show any turn one way. `turn-start` names the harness. A harness keeps its own context, so only the native loop logs `request` events; when a thread moves from another harness to the native loop, the loop is given the conversation so far as text, logged as a `compaction` (`transcript`), and a harness taking a thread over is handed `HarnessTurn.history`, or what it has not seen since its last turn with the state it kept then (`previous`).

A harness's status says the models it offers (`HarnessStatus.models`) and the access levels it keeps (`Access`: supervised, auto-edits, auto, full); a prompt names one of each in `TurnOptions.model` and `access`, which the harness gets in `HarnessTurn`. The web app's model control lists every harness by its mark, with its models, and picking one picks the harness.
