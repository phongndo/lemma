# @lemma/sim

A deterministic simulator of the harness, after TigerBeetle's VOPR: the real
bundled plugins (the sessions store, the agent loop, the tool registry) run in
one process, in simulated time, on a simulated disk, with a model, tools, and
clients that draw what they do from a seed. A seed is a run: the same seed
writes the same bytes to the disk, in any process, so a failure replays from
the seed it prints. Private; tests and `pnpm sim` use it.

## The driver

`Simulation` runs Effect code with three things in place of the real ones:

- **`SimClock`**, Effect's `Clock`: time passes only when the driver moves it,
  so a five-minute timeout costs nothing. A sleep is a timer the driver can
  see; timers wake in the order they are due, each at its own time. The wall
  clock starts at `SIM_EPOCH_MS` and can be stepped, back too.
- **`SimScheduler`**, Effect's scheduler: the batches of work fibers hand it
  wait for the driver, which runs them one at a time. With `shuffle`, which
  fiber's batch runs next is drawn from the seed (Effect promises no order
  between fibers, so any order is one a real run could take); a fiber's own
  batches keep their order.
- **`Prng`**, the seed's source: Effect's `Random`, ids (`IdSource`), the disk's
  faults, and every decision a simulated actor makes. Each part draws from a
  source of its own (`split`), so a change in how often one draws leaves the
  others' draws as they were. `swarm` turns a random subset of kinds of action
  on, each with a weight, once per run.

The driver runs what is ready until nothing is (`settle`; between batches it
lets the event loop run the promise callbacks that are due, as `SimDisk`'s
operations and promise-based code settle through them), then moves the clock
to the next timer, and again. `run(effect)` ends with the effect, fails
`Deadlock` when nothing is left to run and no timer is set, and `TimeLimit`
past its limit of simulated time. Every fiber it starts has `Verify` on.

What it runs must not reach the event loop's timers, the wall clock, or another
random source, or real time would decide what happens when:
`scripts/check-boundaries.ts` keeps the plugins it runs to their seams, and the
determinism tests fail on any timer started during a run.

## A host

`SimHost.start(sim, disk, generation, parts)` starts a host process: a core with
`sessions.files`, `agent.loop`, and `tools.registry` on a mount of a `SimDisk`
(`@lemma/testing`), their ids drawn from the run, the sessions lock claimed by
`generation` as its pid. `parts` adds the model and the tools: `simModel`, which
answers each request as its `Answering` draws (text in timed deltas, and calls
to the tools offered), and `simTools`. `digestOf(disk)` hashes every file on
the disk.

## Running it

`pnpm --filter @lemma/sim sim [--seed <n>]` runs a seed (a random one, printed
first, when none is given). `tests/determinism.test.ts` checks a seed leaves
the same disk twice, and in another process, starting no timer of the event
loop's. Simulated runs name the date in UTC (`TZ`), so a run is the same on
every machine.
