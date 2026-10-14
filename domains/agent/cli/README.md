# agent.cli

The agent's commands for the `lemma` command (`CliCommands` in [`@lemma/cli`](../../cli/README.md)): `run`, and `agent cancel|running|queue|withdraw|steer|wait`. Requires nothing: it reaches the agent and the sessions through their channels (`callHere`, `followHere`), so a reload of either goes on under a running `run` as it would under a client's. No config.

## `run`

- **The turn reported** is the one that places the prompt: a queued
  prompt's runs later, a steer's is the running one. Each run sends a
  request id (`--request-id` to choose it) and gives the client the line that
  rejoins it (`out.rerun`: the session, made by `new` or not, the prompt's
  text, and the id), so a client that loses the run says how to rejoin it
  without making a second session or placing the prompt twice. A prompt a plugin handled instead of placing
  (`AgentInputHook`) prints what the plugin said and exits 0; one a plugin
  refused fails `Refused`.
- **`--follow`** opens `agent.activity` and the session's `sessions.log` before
  it sends the prompt, and shows the turn from the prompt on: the log says
  what the turn did, in order, and the activity fills in the step in flight.
  Output the log has not reached yet waits for it, so one step's answer never
  prints after the next one's. A stream its plugin's reload withdrew opens
  again, the log from the last event shown and the step in flight caught up
  from `agent.view`. With `--json` it prints the `agent.activity` elements and
  the log's events (`appended`) as they come, and the host's notices, then a
  `{ "type": "result", … }` line.
- **Questions** the turn's tools ask carry its session (`session:<id>`): the
  client answers those, as `--questions` says.
- **Images** are `--image` files the client reads, so a host elsewhere gets
  their content.

## `agent wait`

Answers once the session has no turn running and nothing queued, at once
when it is idle already: for a script or an agent that started work with `run`
and does something else meanwhile.
