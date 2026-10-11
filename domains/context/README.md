# context

What the model is told beyond the conversation. The domain has no contract: its plugins add to the agent's ([`@lemma/agent`](../agent/contract/src/agent.ts)), as a plugin of your own would.

| Plugin                                       | Halves | What it does                                                                                                                    |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`context.project`](project/README.md)       | host   | The AGENTS.md (or CLAUDE.md) instructions from home down to the session's directory, as a `PromptSections` section              |
| [`context.compaction`](compaction/README.md) | host   | Keeps a conversation within its model's window: an `AgentRequestHook` handler that summarizes older history into a `compaction` |

## Extending it

| Shape     | What the contract offers                       |
| --------- | ---------------------------------------------- |
| Add       | The agent's `PromptSections`                   |
| Intercept | The agent's `AgentRequestHook`                 |
| Observe   | The agent's and the sessions' events           |
| Call      | `Sessions`, `Llm`, and the rest, as any plugin |
| Serve     | Nothing of its own                             |
