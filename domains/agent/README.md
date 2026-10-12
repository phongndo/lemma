# agent

The agent: the turn loop that asks a model, runs the tools it calls, and logs each step to the session. Its contract is [`@lemma/agent`](contract/src/agent.ts).

| Plugin                         | Halves | What it does                                                                     |
| ------------------------------ | ------ | -------------------------------------------------------------------------------- |
| [`agent.loop`](loop/README.md) | host   | Runs turns: provides `Agent`, and serves it to clients as the `agent.*` channels |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `PromptSections`: a section of the system prompt, written for each request, in the phase `body`, between the agent's base (`base`) and environment (`environment`)                                                                                                                                 |
| Intercept | `AgentInputHook`: a prompt before it is placed (rewrite it, handle it, or refuse it); `AgentRequestHook`: a request before it is logged and sent (its sections, tools, model), in the phase `shape`, or `fit` to see what every other made; `AgentContinueHook`: whether a turn takes another step |
| Observe   | `TurnStarted`, `TurnEnded`, `QueueChanged`, `AssistantDelta`                                                                                                                                                                                                                                       |
| Call      | `Agent`: prompt (answering with its `PromptOutcome`), cancel, the queue (withdraw a prompt, or promote a follow-up to a steer), a session's live view; clients call `AgentChannels`                                                                                                                |
| Serve     | `Agent`, with `serveAgent` for its channels: a plugin providing it replaces `agent.loop`                                                                                                                                                                                                           |
