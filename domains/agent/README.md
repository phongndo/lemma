# agent

The agent: the turn loop that asks a model, runs the tools it calls, and logs each step to the session. Its contract is [`@lemma/agent`](contract/src/agent.ts).

| Plugin                                 | Halves     | What it does                                                                                       |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| [`agent.loop`](loop/README.md)         | host       | Runs turns: provides `Agent`, and serves it to clients as the `agent.*` channels                   |
| [`agent.profiles`](profiles/README.md) | host + web | Profiles: a thread's prompt, tools, sections, and model, chosen per thread (`TurnOptions.plugins`) |
| [`agent.cli`](cli/README.md)           | host       | The `lemma` command's `run` and `agent …`: adds them to `CliCommands`                              |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add       | `PromptSections`: a section of the system prompt, written for each request, in the phase `body`, between the agent's base (`base`) and environment (`environment`)                                                                                                                                                                                                                                                             |
| Intercept | `AgentInputHook`: a prompt before it is placed (rewrite it, handle it, or refuse it); `AgentRequestHook`: a request before it is logged and sent (its sections, tools, model, and the turn's choices for plugins, `plugins`), in the phase `shape`, `select` to choose among what every `shape` handler offered (a profile), or `fit` to see the request as it will be; `AgentContinueHook`: whether a turn takes another step |
| Observe   | `TurnStarted`, `TurnEnded`, `QueueChanged`, `AssistantDelta`                                                                                                                                                                                                                                                                                                                                                                   |
| Call      | `Agent`: prompt (answering with its `PromptOutcome`), cancel, the queue (withdraw a prompt, or promote a follow-up to a steer), a session's live view; clients call `AgentChannels`, and `agent.profiles`' `ProfileChannels`                                                                                                                                                                                                   |
| Serve     | `Agent`, with `serveAgent` for its channels: a plugin providing it replaces `agent.loop`                                                                                                                                                                                                                                                                                                                                       |
