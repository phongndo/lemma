# @lemma/plugin-agent

Provides `Agent` (`@lemma/contracts`): the turn loop. Requires `Sessions`, `Llm`,
`Tools`, `HostControl`, and `Paths`. Exclusive: a reload stops it, suspending
its turns, before the new instance resumes them. Serves the `agent.*` channels
(`AgentChannels`, through `serveAgent`): the calls clients make, and
`agent.activity`, its live output and each turn's and queue's change.

```ts
Effect.gen(function* () {
  const agent = yield* Agent;
  yield* agent.prompt(sessionId, [{ type: "text", text: "Fix the failing test" }]);
  yield* agent.prompt(sessionId, [{ type: "text", text: "Use pnpm" }], { whenBusy: "steer", requestId: "r-42" });
  yield* agent.cancel(sessionId);
});
```

## Config

| Key             | Default                                       | Meaning                                                                                              |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `defaultModel`  | first of `Llm.models({ available: true })`    | `<provider>/<model>` for turns that name none.                                                       |
| `systemPrompt`  | pi-style base prompt                          | Replaces the base section; the environment section is still added.                                   |
| `maxSteps`      | `200`                                         | Model calls per turn before it ends with `max-steps`; retries (below) take none.                     |
| `cli`           | set by `packages/host` to this checkout's CLI | Shell command for the `lemma` CLI, named in the environment section so the agent can inspect itself. |
| `retries`       | `10`                                          | Failed model calls asked again in a row before the turn ends in `error` (see [Retries](#retries)).   |
| `retryDelay`    | `2`                                           | Seconds before the first retry; each later one waits twice as long.                                  |
| `maxRetryDelay` | `60`                                          | Seconds the wait between retries grows to, at most.                                                  |
| `stopGrace`     | `5`                                           | Seconds (at most 20) a stopping agent lets running calls finish (see [Stopping](#stopping)).         |
| `maxRunning`    | `16`                                          | Turns running at once, across sessions; another waits for a slot before its first event.             |

## A turn

1. One turn per session at a time (see [Busy sessions](#busy-sessions)), and at
   most `maxRunning` across sessions: a turn over that waits for a slot, its
   session busy, before its first event, and gives its slot up while it waits
   to ask the model again (see [Retries](#retries)). Cancelled while it waits,
   it ends at once, having logged nothing. The model is resolved (options →
   config → first available) and checked with `Llm.model`; failure is
   `NoModel`, before anything is logged.
2. Answers tool calls the branch left without a result (a checkout put the leaf
   inside a turn, after an answer and before its results, or a turn ended
   without logging them): an error result each, naming the call's turn and
   step. The turn follows the leaf it read, even if a checkout moves it
   meanwhile. Then appends `turn-start` (with the model and thinking level), a
   user `message` per prompt it starts with (each with its `requestId`), and a
   `title` from the first if the session has none.
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
   tool-call delta). `error` appends an `attempt` with the call's `failure`, and
   the call is asked again (see [Retries](#retries)) or the turn ends
   (`cancelled` for an aborted stream, else `error`).
5. Tool calls run through `Tools.execute` with the turn's signal, in order,
   except that a run of consecutive calls whose tools are `parallel: "safe"`
   (`read` is) runs at once, eight at a time. Before calls run, a `custom`
   event (`agent.started`) names them; each result is appended as it arrives, with
   timing and `details`, and the model reads the results in call order. Unknown
   tools and tool failures are error results the model reads. A response that
   stopped at its output limit (`length`) runs none of its calls, whose
   arguments may be cut off: each is answered with an error asking the model to
   make it again.
6. `AgentContinueHook` (default: continue while the model asked for tools, or
   has tool results to read whatever its stop reason), then `step-end`. Steers
   queued meanwhile are placed here as user messages, and the turn goes on to
   another step to answer them even if the model had stopped, unless it is out
   of steps.

`turn-end` closes every turn the agent finishes. On cancellation or failure the
closing sequence logs the partial model output as an `attempt`, answers every
unanswered tool call with an error result (so the next request stays valid),
then `step-end` and `turn-end`. `TurnStarted`/`TurnEnded` carry the summed usage.
A turn the agent is closing under (the host stopping, the plugin reloading) is
left open instead, to resume (see [Stopping](#stopping)).

## Retries

A failed model call is asked again when `Llm.stream`'s classification of the
failure (`LlmFailure`) says asking can help:

- `transient` and `rate-limit`: up to `retries` times in a row, after
  `retryDelay` seconds doubling up to `maxRetryDelay` (±20%, so sessions that
  failed together do not retry together), or after the delay the provider asked
  for (at most 15 minutes).
- `overflow`, a request too long for the model: once, besides those retries,
  with `RequestDraft.overflow` set, so compaction shortens the history whatever
  its own estimate said. Another overflow before the model answers ends the
  turn.
- `fatal` failures (authentication, quota, an invalid request), a cancelled
  turn, and a failure past the budget end the turn in `error`.

The failed call's `attempt` records the `failure` and the `retry` (how many in a
row, and `at`, when the next call starts); its step ends, the turn waits
(without its slot, so a provider's outage does not hold up other sessions), and
a new step asks again. A retry takes no step from `maxSteps`, as the step that
asks again keeps the number. Clients drop a failed call's draft when its
`attempt` arrives, as for any failed call. Tools run only once a response is
complete, so asking again can never run a tool call twice.

## Busy sessions

A prompt sent while the session's turn runs does what its `whenBusy` says:

- `follow-up` (the default): queued; it starts the next turn when this one
  finishes (`done` or `max-steps`), one queued prompt per turn.
- `steer`: queued; placed in the running turn after its current step (step 6).
- `reject`: fails `Busy`.

A session with a turn running cannot be deleted: each turn holds its session
(`Sessions.hold`) from before it starts until it has stopped, through a
stopping agent's grace too (see [Stopping](#stopping)). A prompt that would
start a turn while a deletion runs starts it if the deletion has not reached
the session's file, which it then finds held (`Busy`); otherwise it waits for
the deletion and fails `Session`, as in a session that does not exist. The
agent hears every session removed (`SessionRemoved`, with backpressure rather
than loss): its queued prompts fail `Session` and its journal goes. One removed
while no agent ran goes when the next starts.

`queue` lists what waits, `withdraw` takes a prompt out (its `prompt` call fails
`Retracted`), and `QueueChanged` reports every change with a revision that only
grows, across restarts too (`view` carries it as well), so a client keeps the
newest queue it has heard of whichever arrives first. After a turn that failed
or was cancelled, the queue waits for the next prompt, which places the queued
prompts first, then itself, in one turn. Each `prompt` call resolves when the
turn that placed its prompt ends.

A `requestId` makes a submission exactly-once. A prompt whose id the session
has seen (queued, placed in the running turn, or in a user message in its log)
is not placed again: the call waits for that turn, or returns at once when it
has ended. Clients must give one (`agent.prompt` refuses a call without):
their call ends whenever their connection drops or the agent reloads (see
[Stopping](#stopping)), and they call again with the same id. A plugin calling
`Agent.prompt` may leave it out, and the agent gives the prompt an id of its
own.

`view` is what a client joining the session now needs beyond its log: the
running turn's model output so far (`draft`, through the stream event numbered
`seq`), running tools' output (the tail, and how much each printed), and the
queue. `AssistantDelta` carries the same numbering and `ToolOutput` an offset,
so a client seeded from `view` skips what it already shows.

## Durability

A host that crashes, restarts, or reloads the agent loses no turn and no queued
prompt. Beside the log, under `<Paths.home>/agent`, the agent keeps per session:

- `<session>.json`, the journal: the turn, running or suspended (the prompts it
  was started with, whether it logs `agent.started` events, and whether it is
  being cancelled), and the queue. Written, and synced, before the log is: when
  a turn starts, a prompt is queued, placed, or withdrawn, and when a turn ends.
- `<session>.live.json`: the running turn's model output and tool output so
  far, rewritten at most every 250 ms while it changes, and not synced.

When the agent starts, each journal becomes its session's state as it was: the
queue, and the turn, _suspended_. Then the agent takes each session up: it
holds the session and reads it and its log, once, and the model a suspended
turn continues on. The log is the truth: a queued prompt the log already has
was placed, and a turn the log ended is over. A suspended turn then resumes once
the composition is up, from where its log stops, after a `custom` event
(`agent.resumed`); a session without one runs its queue on, unless the queue
waits for the next prompt (see [Busy sessions](#busy-sessions)). Where a turn
stops is the last event that names it, reached back to its `turn-start` by
parents, so titles a rename hung off the turn meanwhile do not mislead it.

- A model call cut off (its `request` logged, no answer) is logged as an
  `attempt` with what it had produced (from the live file), the error
  `Interrupted: the host stopped during this model call`, and `retry` with the
  reason `restart`, and asked again in a new step. The cut-off call counted as a
  step: a turn with none left ends `max-steps` instead. A failed call that was
  waiting to be asked again is asked once its wait is over.
- A tool call without a result that had started (an `agent.started` event names
  it) runs again when its tool is declared `replay: "safe"` (`read` is);
  otherwise the model gets an error result saying it was interrupted and may or
  may not have finished, with the output it had printed. A call that had not
  started runs. In a turn an older agent started, which logged no such events,
  every call without a result counts as started.
- A turn whose `cancel` was asked for closes as cancelled (one cut off before
  its first event never runs); one whose model call had failed closes the way
  it was closing. Steers it had placed before the restart are answered.

The model is the one the turn was started with (`turn-start`), else the default.
After the resumed turn, the queue runs on. Prompts a client sent before the
restart can be awaited again with their `requestId`.

Taking a session up changes nothing until the session, its log and the model
have been read. A session the store says does not exist (`NotFound`) goes,
journal and all. One that cannot be taken up otherwise (the store fails, or no
model resolves) stays as it was, its journal untouched, with a warning in the
log; it is taken up when it is next prompted, the prompt failing as the reading
did if it still cannot be, or at the next start. Until then its turn stays
suspended, and is not running: `busy`, `running` and `view` leave it out, and
nothing holds the session for it, so the session can be deleted, which drops
the turn. `queue` and `withdraw` see the session's queue. `cancel` marks the
turn cancelling in the journal, so it closes as cancelled, without asking the
model again, when it is taken up: at once, if it can be.

## Stopping

When the agent closes (the host stopping, or a reload of it or of a plugin it
requires), each running turn stops at its next step or tool call and is left
open, without a `turn-end`; a turn waiting to ask again stops at once. Calls
already running get `stopGrace` seconds to finish and log their results; what
still runs after that is interrupted, as a crash would cut it off. Either way
the turn resumes when the agent starts again (see [Durability](#durability)),
and the calls of its step that had not started run then. A call waiting on
`agent.prompt` stops waiting as soon as the agent starts closing, before its
turns are suspended, so it never holds the agent's stop; the call is
`repeatable`, so once the reload has finished the host makes it again, with the
same `requestId`, on the new instance, and its client waits on.

A host stopping shuts the core's hooks before it closes the agent (they fail
closed, so no guard is skipped), and a turn can take no step without them: one
that finds them shut (the core refuses the call with `CoreClosed`) is left open
the same way, and so is one that fails in any way while the agent closes. A
model call or tool call that fails because of the shutdown logs nothing: it is
asked again, or run (or reported interrupted) when the turn resumes.

## Rationale

- **Explicit parents.** After `turn-start`, every append names the previous event
  as its parent, so a `checkout` during a turn cannot splice the turn into another
  branch. Request handlers append through the turn too (`RequestDraft.append`),
  so their events chain the same way, and one appended before a later handler
  fails or the turn is cancelled stays on the turn's branch.
- **Branch points in the log.** A provider needs a result for every tool call,
  and pi-ai would make one up for a call that has none, sending what the log
  does not hold. So a turn begun after a checkout into a turn logs those
  results first; `rebuildRequest` then rebuilds what was sent.
- **Plugin-owned turns.** Turns are forked into the plugin's scope. `prompt` awaits
  the turn, but interrupting the caller does not cancel it; only `cancel` does
  (abort the signal, then interrupt), and it returns after `turn-end` is logged
  (or, for a turn still waiting for a slot, once it has ended without logging).
  Closing the plugin suspends running turns (see [Stopping](#stopping)).
- **Intent before effect.** `agent.started` is synced before a tool call runs,
  so a restart tells a call that may have run from one that never did, and runs
  the latter rather than reporting it interrupted.
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
suspended (see [Durability](#durability)), or prompts queued: the turn, since
when it runs, whether it is suspended or being cancelled, and how many prompts
wait.
