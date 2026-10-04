# @lemma/plugin-agent

Provides `Agent` (`@lemma/contracts`): the turn loop. Requires `Sessions`, `Llm`,
`Tools`, `HostControl`, and `Paths`. Exclusive: a reload stops it, suspending
its turns, before the new instance resumes them.

```ts
const agent = yield * Agent;
yield * agent.prompt(sessionId, [{ type: "text", text: "Fix the failing test" }]);
yield * agent.prompt(sessionId, [{ type: "text", text: "Use pnpm" }], { whenBusy: "steer", requestId: "r-42" });
yield * agent.cancel(sessionId);
```

## Config

| Key            | Default                                       | Meaning                                                                                              |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `defaultModel` | first of `Llm.models({ available: true })`    | `<provider>/<model>` for turns that name none.                                                       |
| `systemPrompt` | pi-style base prompt                          | Replaces the base section; the environment section is still added.                                   |
| `maxSteps`     | `200`                                         | Model calls per turn before it ends with `max-steps`.                                                |
| `cli`          | set by `packages/host` to this checkout's CLI | Shell command for the `lemma` CLI, named in the environment section so the agent can inspect itself. |

## A turn

1. One turn per session at a time (see [Busy sessions](#busy-sessions)). The
   model is resolved (options → config → first available) and checked with
   `Llm.model`; failure is `NoModel`, before anything is logged.
2. Appends `turn-start` (with the model and thinking level), a user `message`
   per prompt it starts with (each with its `requestId`), and a `title` from the
   first if the session has none.
3. Each step: `step-start`; a `RequestDraft` with the base section and an
   environment section (cwd, date, platform, session id, and the `cli` command
   when configured; source `agent`), `Tools.list`, the turn's branch and
   `deriveMessages(branch)`, and `append`; `AgentRequestHook`, whose handlers
   change what the model sees by appending events with `append` (a
   `compaction`, whose `usage` the turn's then includes); the `request` event with
   per-section and per-tool `contributions`, the `HostControl.composition` id, and
   `system`/`tools` only when they differ from `requestState(branch)`. The request
   actually sent is `rebuildRequest` over the branch ending at that event, so the
   log invariant holds by construction.
4. `Llm.stream`: every event is published as `AssistantDelta`. `done` appends the
   assistant `message` with timing (`firstTokenAt` = first text, thinking, or
   tool-call delta). `error` appends an `attempt` and ends the turn (`cancelled`
   for an aborted stream, else `error`). No automatic retry.
5. Tool calls run in order through `Tools.execute` with the turn's signal; each
   result is appended with timing and `details`. Unknown tools and tool failures
   are error results the model reads.
6. `AgentContinueHook` (default: continue iff `stopReason === "toolUse"`), then
   `step-end`. Steers queued meanwhile are placed here as user messages, and the
   turn goes on to another step to answer them even if the model had stopped,
   unless it is out of steps.

`turn-end` closes every turn the agent finishes. On cancellation or failure the
closing sequence logs the partial model output as an `attempt`, answers every
unanswered tool call with an error result (so the next request stays valid),
then `step-end` and `turn-end`. `TurnStarted`/`TurnEnded` carry the summed usage.
A turn the agent is closing under (the host stopping, the plugin reloading) is
left open instead, to resume (see [Durability](#durability)).

## Busy sessions

A prompt sent while the session's turn runs does what its `whenBusy` says:

- `follow-up` (the default): queued; it starts the next turn when this one
  finishes (`done` or `max-steps`), one queued prompt per turn.
- `steer`: queued; placed in the running turn after its current step (step 6).
- `reject`: fails `Busy`.

`queue` lists what waits, `withdraw` takes a prompt out (its `prompt` call fails
`Withdrawn`), and `QueueChanged` reports every change with a revision that only
grows, across restarts too (`view` carries it as well), so a client keeps the
newest queue it has heard of whichever arrives first. After a turn that failed
or was cancelled, the queue waits for the next prompt, which places the queued
prompts first, then itself, in one turn. Each `prompt` call resolves when the
turn that placed its prompt ends.

A `requestId` makes a submission exactly-once. A prompt whose id the session
has seen (queued, placed in the running turn, or in a user message in its log)
is not placed again: the call waits for that turn, or returns at once when it
has ended. Without one, the agent gives the prompt an id of its own. Clients
reuse the id when they retry after a lost connection.

`view` is what a client joining the session now needs beyond its log: the
running turn's model output so far (`draft`, through the stream event numbered
`seq`), running tools' output (the tail, and how much each printed), and the
queue. `AssistantDelta` carries the same numbering and `ToolOutput` an offset,
so a client seeded from `view` skips what it already shows.

## Durability

A host that crashes, restarts, or reloads the agent loses no turn and no queued
prompt. Beside the log, under `<Paths.home>/agent`, the agent keeps per session:

- `<session>.json`, the journal: the running turn (and the prompts it was
  started with) and the queue. Written, and synced, before the log is: when a
  turn starts, a prompt is queued, placed, or withdrawn, and when a turn ends.
- `<session>.live.json`: the running turn's model output and tool output so
  far, rewritten at most every 250 ms while it changes, and not synced.

When the agent starts, it reads the journals. The log is the truth: a queued
prompt the log already has was placed, and a turn the log ended is over. Each
open turn resumes once the composition is up, from where its log stops, after a
`custom` event (`agent.resumed`). Where it stops is the last event that names
the turn, reached back to its `turn-start` by parents, so titles a rename hung
off the turn meanwhile do not mislead it.

- A model call cut off (its `request` logged, no answer) is logged as an
  `attempt` with what it had produced (from the live file) and the error
  `Interrupted: the host stopped during this model call`, and asked again in a
  new step. The cut-off call counted as a step: a turn with none left ends
  `max-steps` instead.
- A tool call cut off (no result) runs again when its tool is declared
  `replay: "safe"` (`read` is); otherwise the model gets an error result saying
  it was interrupted and may or may not have finished, with the output it had
  printed.
- A turn whose `cancel` was asked for closes as cancelled (one cut off before
  its first event never runs); one whose model call had failed closes the way
  it was closing. Steers it had placed before the restart are answered.

The model is the one the turn was started with (`turn-start`), else the default.
After the resumed turn, the queue runs on. Prompts a client sent before the
restart can be awaited again with their `requestId`.

## Rationale

- **Explicit parents.** After `turn-start`, every append names the previous event
  as its parent, so a `checkout` during a turn cannot splice the turn into another
  branch. Request handlers append through the turn too (`RequestDraft.append`),
  so their events chain the same way, and one appended before a later handler
  fails or the turn is cancelled stays on the turn's branch.
- **Plugin-owned turns.** Turns are forked into the plugin's scope. `prompt` awaits
  the turn, but interrupting the caller does not cancel it; only `cancel` does
  (abort the signal, then interrupt), and it returns after `turn-end` is logged.
  Closing the plugin suspends running turns: they are interrupted without a
  `turn-end` and resume when the agent starts again.
- **Journal before log.** A turn is in the journal before its first event is in
  the log, and leaves it after its `turn-end`; a steer leaves the queue after its
  message is logged. Whichever write a crash falls between, the restart finds
  enough to resume, and the log settles any disagreement.
- **Uninterruptible appends.** Each append and the bookkeeping that follows it
  complete together, so a cancel can never leave an event in the log that the
  closing sequence does not know about (which would duplicate tool results).
- **Errors.** LLM failures are recorded in the log (`attempt`, `turn-end` with
  `error`) and `prompt` resolves; `Session` and `Hook` failures also fail `prompt`.
  A cancelled turn resolves normally.

## Inspector

`agent.turns` (in `Inspectors`) lists the sessions with a turn running or
prompts queued: the turn, since when, whether it is being cancelled, and how
many prompts wait.
