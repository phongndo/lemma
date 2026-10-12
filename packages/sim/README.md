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
when its next timer is past its limit: a time on the simulation's clock,
counted from when the simulation began (a day by default), not from the call.
Every fiber it starts has `Verify` on, and Effect's `Random`, one source for
the whole run.

What it runs must not reach the event loop's timers, the wall clock, or another
random source, or real time would decide what happens when:
`scripts/check-boundaries.ts` keeps the plugins it runs to their seams, and
the determinism tests fail on any timer a run starts (see "Running it").

## A host

`SimHost.start(sim, disk, generation, parts, alive)` starts a host process: a
core with `sessions.files`, `agent.loop`, and `tools.registry` on a mount of a
`SimDisk` (`@lemma/testing`), their ids drawn from the run, the sessions lock
claimed by `generation` as its pid. `alive` holds the generations still running:
a lock an earlier one holds is stale once it is not among them, as a crashed
process's is. `parts` adds the rest: compaction, the simulated
model (`simModel`: text in timed deltas, calls to the tools offered, and a
provider's failures: transient, rate limits naming a delay, fatal, overflow,
stalls, broken streams, malformed calls, and usage that fills the context),
tools (`simTools`: `echo`, safe to repeat; `work`, which prints a line per
step, may fail or run for minutes, and is unsafe to repeat), a plugin around
the agent's operations that slows or fails them (`simHooks`), and the checker's
observer. `digestOf(disk)` hashes every file on the disk (its doc says how it
counts a temporary one a crash left).

## A run: `World`

`new World({ seed }).run()` is TigerBeetle's VOPR for the harness. The seed
draws the run's mix (`drawSwarm`): which actions its clients and the world take
and how often, and how often each part fails. A run leans on one part
(`focus`): `broad` draws every part alike; `disk`, `model`, and `lifecycle`
draw that part's faults often and high, with the actions that make them matter
on, as a bug often needs one part failing a lot rather than every part a
little. Odd seeds shuffle fibers' work (`shuffle`).

- **Safety phase.** Each tick takes one action, then lets simulated time pass.
  Clients call the hosts' channels as the transport does (`callServed`, so a
  reload repeats a `repeatable` call): prompts (follow-up, steer, reject),
  retries of a prompt whose fate they never learned (same request id), cancels,
  withdrawals, and checkouts. The world crashes the disk at once or part-way
  through a write (`crashAfter`), stops hosts, restarts the agent, the store,
  or the registry mid-turn, and sets the wall clock back. A crash takes its
  host's clients with it as it strikes: they hear nothing more from it.
- **Liveness phase.** Nothing fails any more. A new host takes every prompt
  whose fate its client never learned again, and a new prompt in each session
  whose queue waits after a failed turn; then within two simulated hours every
  client's call must end and every session be idle.
- **Audit.** A host started on what the run left serves its log, which the
  checker reads beside the bytes of each session's file.

The checker (`Checker`), TigerBeetle's state checker, holds the run to:

- every event the store reported appended, or served after a restart, is
  still there, as it was, after any later crash or stop;
- the store serves what each file holds;
- every request the log records rebuilds well formed (every call answered, no
  result without its call), and every request the model was asked is one the
  log rebuilds;
- every closed turn answered each call it made before it closed;
- a prompt is placed at most once; once if a call to send it answered
  `placed`; never if it was withdrawn or every call was answered without it
  (`Busy`, `Retracted`, handled, refused; `Io` is not a refusal, as a journal
  write that failed may have landed);
- no call of `work`, unsafe to repeat, begins twice;
- a tool's output only moves on, and all of it comes before its result;
- a model call's streamed text is the text the log has for it;
- a queue's revision only grows, across restarts and a clock set back;
- no client call ends in a defect, no plugin breaks an assertion, and a
  plugin fails only from a fault the run injected into it.

### What it found

Each is fixed (the last by documenting what `Io` means), and pinned by a test
of the agent's own, in `domains/agent/loop/tests/simulated.test.ts` (the
cancelled turn's in `recovery.test.ts`), as a seed replays a run only at the
commit that drew it:

- a resumed turn waited for a retry as long as the wall clock had been set
  back, an hour and more;
- a queue's revision went back after a restart with the clock set back (an
  idle session's journal, which held it, was gone), or was told again with
  another queue by an instance started in the same millisecond: revisions now
  count on from a durable count of the agent's starts, not the clock;
- a prompt of a turn cancelled before it began answered `placed`, though it
  never ran (it now fails `Retracted`, as a withdrawn one does);
- a prompt withdrawn, and sent again by a client that never heard so (it
  reconnects and retries with the same request id), was placed;
- a turn resumed after a restart whose first write failed (a full disk) closed
  without answering the calls its cut-off step had left;
- an agent starting on a disk that failed to list its state took that for no
  state, and started over as if it had none;
- a journal write that failed after its rename had landed left a prompt
  reported `Io` placed by the next host (`Io` is now documented as of unknown
  fate: send it again with the same request id).

### Testing the tester

Reintroduced, each of three earlier bugs is caught (200 seeds at the default
200 ticks): tool output delivered on a detached fiber, after its call returned
(#22), in 140 seeds; no repair of a session's last line before it is served
(#26), in 4; and no `agent.started` event before tools run, in 44.

## Running it

`pnpm --filter @lemma/sim sim [--seed <n>] [--count <n>] [--forever] [--ticks
<n>] [--dump]` runs seeds from `n` (a random one, printed first, when none is
given), stopping at the first that fails, and prints how to replay it; `--dump`
prints each session's log as the run left it. `tests/world.test.ts` runs
`LEMMA_HARNESS_RUNS` seeds (default 16) from `LEMMA_HARNESS_SEED` at
`LEMMA_HARNESS_TICKS` ticks (default 120), and a seed twice to check it leaves
the same disk; `tests/determinism.test.ts` checks a seed leaves the same disk
in another process, starting no timer of the event loop's. Simulated runs name
the date in UTC (`TZ`), so a run is the same on every machine.
