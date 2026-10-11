# agent

The agent: the turn loop that asks a model, runs the tools it calls, and logs each step to the session. Its contract is [`@lemma/agent`](contract/src/agent.ts).

| Plugin                         | Halves | What it does                                                                     |
| ------------------------------ | ------ | -------------------------------------------------------------------------------- |
| [`agent.loop`](loop/README.md) | host   | Runs turns: provides `Agent`, and serves it to clients as the `agent.*` channels |

## Extending it

| Shape     | What the contract offers                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `PromptSections`: a section of the system prompt, written for each request, between the agent's base (`SectionOrder.base`) and environment      |
| Intercept | `AgentRequestHook`: a request before it is logged and sent (its sections, tools, model); `AgentContinueHook`: whether a turn takes another step |
| Observe   | `TurnStarted`, `TurnEnded`, `QueueChanged`, `AssistantDelta`                                                                                    |
| Call      | `Agent`: prompt, cancel, the queue, a session's live view; clients call `AgentChannels`                                                         |
| Serve     | `Agent`, with `serveAgent` for its channels: a plugin providing it replaces `agent.loop`                                                        |
