# agent

The agent: the turn loop that asks a model, runs the tools it calls, and logs each step to the session. Its contract is [`@lemma/agent`](contract/src/agent.ts).

| Plugin                             | Halves     | What it does                                                                                                        |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| [`agent.loop`](loop/README.md)     | host + web | Runs turns: provides `Agent`, and serves it to clients as the `agent.*` channels                                    |
| [`agent.modes`](modes/README.md)   | host + web | Modes: a thread's prompt, tools, sections, and model, chosen with its first prompt (`TurnOptions.plugins`) and kept |
| [`agent.titles`](titles/README.md) | host + web | Names threads with the small model: once the first turn titles one from its prompt, and anew when asked             |
| [`agent.cli`](cli/README.md)       | host       | The `lemma` command's `run` and `agent …`: adds them to `CliCommands`                                               |

A loop of another kind need not start from nothing: `@lemma/agent/kit` is `agent.loop`'s implementation as pieces, from the whole agent shaped by a `TurnPolicy` (`makeAgent`) to one turn over the log (`runTurn`), a restart's resume plan (`planResume`), the journal, the queue's rules, and the live view.

A plugin replacing `agent.loop` runs `agentConformance` from `@lemma/agent/testing`: what clients and plugins rely on of an `Agent` (prompts placed once, requests that rebuild from the log, tool calls run once and answered, the busy rules, cancel, withdraw, and the hooks' say), against the contract alone.

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `PromptSections`: a section of the system prompt, written for each request, in the phase `body`, between the agent's base (`base`) and environment (`environment`)                                                                                                                                                                                                                                                          |
| Intercept | `AgentInputHook`: a prompt before it is placed (rewrite it, handle it, or refuse it); `AgentRequestHook`: a request before it is logged and sent (its sections, tools, model, and the turn's choices for plugins, `plugins`), in the phase `shape`, `select` to choose among what every `shape` handler offered (a mode), or `fit` to see the request as it will be; `AgentContinueHook`: whether a turn takes another step |
| Observe   | `TurnStarted`, `TurnEnded`, `QueueChanged`, `AssistantDelta`                                                                                                                                                                                                                                                                                                                                                                |
| Call      | `Agent`: prompt (answering with its `PromptOutcome`), cancel, the queue (withdraw a prompt, or promote a follow-up to a steer), a session's live view; clients call `AgentChannels`, and `agent.modes`' `ModeChannels`. `ModelNotice`: publish one to tell the model what no prompt carries (a background command exited), as a `context` event that reaches it now, without requiring `Agent`                              |
| Serve     | `Agent`, with `serveAgent` for its channels: a plugin providing it replaces `agent.loop`                                                                                                                                                                                                                                                                                                                                    |
