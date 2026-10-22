# Fresh loop (an agent of another kind, built on the agent kit)

An `Agent` that starts each turn fresh: in place of the whole history, the
model is given a short handoff of the turn before (what it was asked, and what
it answered), as a "Ralph" loop does, so long threads stay cheap and each turn
stays on its prompt. [`fresh-loop.ts`](fresh-loop.ts) is the whole of it:
everything else (the queue, the journal, resuming after a restart, the live
view, the `agent.*` channels) is the agent kit's (`@lemma/agent/kit`'s
`makeAgent`), as `agent.loop` has it.

The handoff is a `compaction` the first request of each turn appends
(`AgentRequestHook`, in `fit` before compaction), so every request still
rebuilds from the log, and the transcript marks where each turn started fresh.

| Shape     | What it uses                                               |
| --------- | ---------------------------------------------------------- |
| Serve     | `Agent`: it provides it, so it takes `agent.loop`'s place  |
| Call      | `Sessions`, `Llm`, `ToolRunner`, as `makeAgent` needs them |
| Intercept | `AgentRequestHook`: the handoff, once a turn               |

To use it:

```sh
ln -s "$PWD/examples/fresh-loop" ~/.lemma-dev/plugins/fresh-loop   # agent.loop turns off while it runs
```

`nix develop -c pnpm --filter @lemma/example-fresh-loop test` runs the Agent
conformance suite (`@lemma/agent/testing`) against it, as `agent.loop` runs
it, runs the harness simulator's workload on it under faults, crashes, and
restarts (`World`'s `agent`, given `makeFreshLoop` with the run's disk and
ids), and checks that a second turn's request holds only the handoff and its
prompt.
