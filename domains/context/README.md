# context

What the model is told beyond the conversation, and how a conversation is kept within its model's window. Its contract is [`@lemma/context`](contract/src/index.ts): the hook around a compaction. Its plugins otherwise add to the agent's ([`@lemma/agent`](../agent/contract/src/agent.ts)), as a plugin of your own would.

| Plugin                                       | Halves    | What it does                                                                                                                                                                                   |
| -------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`context.project`](project/README.md)       | host      | The AGENTS.md (or CLAUDE.md) instructions from home down to the session's directory, as a `PromptSections` section                                                                             |
| [`context.prune`](prune/README.md)           | host      | Off until turned on: shortens old, long tool results in what the model sees (`context-edit` events) in place of a summary                                                                      |
| [`context.compaction`](compaction/README.md) | host, web | Keeps a conversation within its model's window: an `AgentRequestHook` handler that summarizes older history into a `compaction`; in the web app, a context and cache-hit meter in the composer |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Add       | The agent's `PromptSections`                                                                                                  |
| Intercept | `CompactionHook`: a compaction about to be made (write its summary, move its cut, or skip it); the agent's `AgentRequestHook` |
| Observe   | The agent's and the sessions' events                                                                                          |
| Call      | `Sessions`, `Llm`, and the rest, as any plugin                                                                                |
| Serve     | Nothing of its own                                                                                                            |
