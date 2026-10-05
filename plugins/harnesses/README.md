# @lemma/plugin-harnesses

Provides `Harnesses` (`@lemma/contracts`): the registry of what can run a turn.
The [agent](../agent/README.md) registers the native harness (`lemma`, Lemma's
own loop) and runs every session's turns through the harness each turn names;
other plugins register other agents, such as the [ACP harness](../harness-acp/README.md).
No config.

```ts
const harnesses = yield * Harnesses;
yield *
  harnesses.register({
    id: "mine",
    title: "My agent",
    capabilities: { steer: false, models: false, resume: false, requests: false },
    status: Effect.succeed({ state: "ready" }),
    run: (turn) =>
      recordTurn({ sessions, events }, turn, { harness: "mine", api: "mine", provider: "mine", model: "default" }, (record) => drive(record, turn)),
  });
```

## The registry

- `register` records the registering plugin's id as `source` and removes the
  harness when that plugin's scope closes. A duplicate id fails `Duplicate`,
  naming the plugin that holds it.
- `list` is the native harness first, then by title. Each harness's `status`
  is asked once and remembered; `refresh` asks every one again (after
  installing an agent, say). A status check that fails, or takes over five
  seconds, reads as `unavailable` with the reason.
- `HarnessesChanged` carries the list after every registration, removal, and
  refresh; the transport forwards it as `harnesses-changed`.
- **Inspector.** `harnesses.registered` lists each harness with its plugin,
  status, and capabilities.

## Capabilities

A harness says what it can do, and the agent and clients branch on that, never
on its id. Each missing capability has a fallback:

| Capability | With it                                                    | Without it                                                                |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `steer`    | Steers join its running turn between steps.                | A steer waits in the queue and starts the next turn.                      |
| `models`   | It runs on the model the turn names (`TurnOptions.model`). | It runs on a model of its own choosing; clients hide the picker.          |
| `resume`   | A turn a restart cut off continues where it stopped.       | The turn is closed as interrupted; the next prompt starts afresh.         |
| `requests` | Every model request is logged and rebuildable.             | The log records what it did (messages, tool calls), not what it was sent. |

## Recording another agent's turn

`recordTurn(services, turn, producer, body)` logs a turn that another agent runs
the way the native loop logs one, so every client shows it the same way. `body`
reports what the agent does through a recorder (`text`, `thinking`, `toolCall`,
`toolResult`, `usage`, `model`, `custom`) and returns how the turn ended.

- **Events.** `turn-start` naming the harness, a user `message` per prompt, a
  `title` when the session has none, then per stretch of model output a step:
  `step-start`, the assistant `message` with its tool calls (`api`, `provider`,
  and `model` from `producer`), their results, `step-end`. `turn-end` closes it.
  No `request` events. `TurnStarted`, `AssistantDelta` (each delta also applied
  to the turn's live view), and `TurnEnded` are published as the native loop
  publishes them.
- **Steps.** A step's assistant message is logged when the first of its calls
  gets a result, so each result follows its call; output after a result starts
  the next step. A call reported again (agents report input late, and with
  every status change) updates the call while its message is unlogged, and is
  published only when its name or input changed. A result for a call never
  reported, or already answered, is ignored.
- **Cost.** `usage` adds to the turn's total, carried by the next assistant
  message logged; cost reported after the last one is carried by an empty one,
  so the log's total stays whole.
- **Closing.** However the body ends, the unlogged output is logged (as
  `aborted` or `error` when the turn did not finish), every unanswered call
  gets an error result, then `step-end` and `turn-end`. That includes the
  agent suspending the turn (the host stopping): another agent's prompt stops
  with the host, so the turn ends `error` at once, keeping what it produced,
  instead of waiting for a resume that cannot happen.
- **A turn a crash left open** (`turn.resume`): the body is not run. The
  turn's open step and unanswered calls are closed after its last event, and
  it ends `error` (or `cancelled`, when its cancel came first).

Every append names the previous one as its parent, as the native loop's do.
