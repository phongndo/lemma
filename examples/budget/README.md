# Budget (an example of watching and steering the agent's turns)

A token budget for each turn, and a meter. The [plugin](budget.ts) stops a
turn that has used `maxTokens` before it asks the model again, and when a
turn ends it posts a notice: how long the turn took, how often it asked the
model and for how long, how much text the model wrote, and the tokens it
used, as a `Notice` (`@lemma/contracts`), which the web app shows as a toast.

| Shape     | What it uses                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intercept | `AgentContinueHook` (after the agent's decision, stopping a turn over budget), `LlmRequestHook` (timing each call's stream and counting its text) |
| Observe   | `TurnStarted`, `TurnEnded` (`@lemma/agent`)                                                                                                       |

Observers run on their own, apart from the turn: a model call can come
before the plugin has observed its turn's start, so its meter is made by
whichever comes first. The budget counts each step's usage as the agent
reports it to `AgentContinueHook`; a step under way finishes, so a turn can
end a step past its budget.

`maxTokens` in its row's `config` sets the budget; 0, the default, meters
without one.

To use it:

```sh
ln -s "$PWD/examples/budget" ~/.lemma/plugins/budget   # or copy the folder
```

`nix develop -c pnpm --filter @lemma/example-budget test` runs it in real
turns, with a scripted model (`scriptedLlm` from `@lemma/llm/testing`).
