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

`SimHost.start(sim, fs, generation, parts, alive)` starts a host process: a core
with `sessions.files`, `agent.loop`, and `tools.registry` on `fs`, a mount of a
`SimDisk` (`@lemma/testing`) or, for the benchmark, a `MemFs`, their ids drawn
from the run, the sessions lock
claimed by `generation` as its pid. `alive` holds the generations still running:
a lock an earlier one holds is stale once it is not among them, as a crashed
process's is. `parts` adds the rest: compaction, the simulated
model (`simModel`: text in timed deltas, calls to the tools offered, and a
provider's failures: transient, rate limits naming a delay, fatal, overflow,
stalls, broken streams, malformed calls, and usage that fills the context),
tools (`simTools`: `echo`, safe to repeat; `work`, which prints a line per
step, may fail or run for minutes, and is unsafe to repeat), a plugin around
the agent's operations that slows or fails them (`simHooks`), and the checker's
observer; `wrapSessions` wraps the store's service (the benchmark counts its
reads so). `digestOf(disk)` hashes every file on the disk (its doc says how it
counts a temporary one a crash left).

## A run: `World`

`new World({ seed }).run()` is TigerBeetle's VOPR for the harness. The seed
draws the run's mix (`drawSwarm`): which actions its clients and the world take
and how often, and how often each part fails. A run leans on one part
(`focus`): `broad` draws every part alike; `disk`, `model`, `tools`, and `lifecycle`
draw that part's faults often and high, with the actions that make them matter
on, as a bug often needs one part failing a lot rather than every part a
little. Odd seeds shuffle fibers' work (`shuffle`).

A `World` runs `agent.loop` unless given another plugin providing `Agent` (`agent`, an `AgentFactory` given the run's disk, ids, and platform): a replacement runs the same workload, faults, and checks.

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
- a tool's output only moves on, and all of it comes before its result (where
  fibers run in the order they became ready, so the checker hears events in
  the order they were published);
- a model call's streamed text is the text the log has for it;
- a queue's revision only grows, across restarts and a clock set back;
- no client call ends in a defect, no plugin breaks an assertion, and a
  plugin fails only from a fault the run injected into it.

### What it found

Each is fixed (the `Io` one by documenting what it means), and pinned by a test
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
  fate: send it again with the same request id);
- a prompt a turn failed to log, in a turn whose `turn-end` failed too, was
  answered `placed` when sent again while the turn closed, though it never
  was (a turn that ended now keeps none of its prompts).

### Testing the tester

Reintroduced, each of three earlier bugs is caught (seeds 1 to 200 at the
default 200 ticks, measured at the commit that last changed the generator):

- each chunk of a tool's output sent on a detached fiber of its own, a turn
  later, so after its call returned (#22): in 65 seeds, the first seed 2;
- no `agent.started` event before tools run: in 44, the first seed 2;
- no repair of a session's last line before it is served (#26): in 1, seed 189.
  It needs a sync, then the cut of the line it left, to fail, then a restart,
  then a crash: about one run in 200, ten a night. The session log's own
  simulation (`domains/sessions/files/tests/simulation.test.ts`), the focused
  test beside this whole-system one, as TigerBeetle pairs them, catches it every
  time.

## The harness benchmark

`pnpm harness:bench` (`bench/harness.ts`) runs one session through turns of two
steps (the model calls `echo`, then answers in five deltas), in simulated time
on a file system in memory (`MemFs`: an append grows its file in place, where
`SimDisk` copies it whole), with compaction on: the model reports the context
each request fills, in a window of 4,000 tokens, so the session compacts every
few dozen turns as a real one does once its context is full, and a request's
history stays within the same bounds at 1,000 entries as at 10,000. It
measures each step at 100, 1,000, and 10,000 entries, with `Verify` off, as in
production. Simulated waits cost no wall time, so a step's wall time is the
harness's, with the simulation's driver, the scripted model and tools, `MemFs`,
and the plugin counting hooks and events beside it. What it counts per step is
the same on every machine, and is a hard budget
(`packages/core/bench/budgets.ts`), held against the exact total over the
measured steps, so one sync more in twenty steps fails it; the most a single
turn takes has a budget too, so a costly turn cannot hide in the average.
`tests/bench.test.ts` pins the totals on a short session in CI, on Linux and
macOS. Timings are advisory: a step's (a tool step's and an answer step's
apart), and a text delta's to an observer, over the measured turns alone;
`scripts/bench-compare.ts --harness` compares steps' between builds.

### The estimate

A step is one model call and the tools it asks for. What the harness adds to
it, by resource (TigerStyle's sketch: network, disk, memory, CPU, each for
bandwidth and latency):

- **Network.** The request is the context, which the model needs whatever the
  harness does; the harness adds nothing to it. Latency is the model's:
  seconds.
- **Disk.** About six log lines a step (step start, request, answer, the tools'
  start and results, step end), 2.1 KB, each synced before the next, as resuming
  after a crash depends on each: 6 to 8 syncs, at 0.2 to 2 ms on an SSD, 2 to 15
  ms a step. The slowest resource the harness touches, and a cost per step that
  stays the same as the session grows.
- **Memory.** An open session's events, about 1 KB each: 10 MB at 10,000.
- **CPU.** The request is built from the session's branch: done
  incrementally, a step's work is the new events and the request's own size,
  the same at 10,000 entries as at 100. The target: a step at 10,000 entries
  within 1.5 times one at 1,000, and an event from the model reaching a client
  within a frame (16 ms).

### What it measures

At first (2026-10-12, Ryzen 9 9950X), a step read its whole branch back from
the store about twice (422, 2,664, and 25,159 events at 100, 1,000, and
10,000 entries) and took 1.38, 1.54, and 2.29 ms: 1.5 times as long at 10,000
entries as at 1,000. Now a turn keeps its branch as it appends, and a new turn
starts from the one the last left while the session's leaf is still its end
(`agent.loop`'s README): a step reads nothing back, and took 1.50, 1.59, and
1.66 ms (2026-10-21, before the changes below). Most of what still grew with
the session was building the request: 26% of a step at 10,000 entries, and 15%
more in `LlmRequest`'s constructor, which copies every message of the history
it is given (`disableChecks` skips only refinements). Now the request is made
of its logged fields without that copy (`requestFrom`), the model's view of the
branch is derived once a step and walks the view rather than the whole branch,
and the kernel's events and hooks take fewer steps: a step takes 1.23, 1.04,
and 0.93 ms (`scripts/bench-compare.ts --harness`, 10 runs, 2026-10-21) and
allocates about 1 MB, from 1.4 to 1.8. Each step writes 8 syncs and 2.1 KB
(2.4 KB until a request logged its contributions only when they change, as it
did its system prompt and tools), runs 3 public hooks, and publishes 22.5 events (45 a turn); a text delta
reaches an observer in 0.01 ms (p50) and 0.04 ms (p99). The p99 was 0.4 to
0.6 ms: a reply's last delta comes with its end, and its observer waited for
the turn to log the answer, until the turn let observers hear the end first.
Of a step's time, about 40% is Effect's own running of its fibers (some 1,700
operations), and 5% the simulation's own code (its driver, which hands the
event loop a turn between every batch, the model, the tools, and `MemFs`).
The disk's syncs stay
as they are: each is a point the agent's resume depends on, and syncing two
lines at once would need the store's contract to say which may share one.

The hooks counted leave out two: a provider plugin's `LlmRequestHook`, one a
step, which the simulated model (an `Llm` of its own) runs none of; and the
agent's own probe of whether the core is closing, a hook no other plugin can
name, which runs before each batch of tool calls a step starts, before each
call, and after a model call or a turn that fails: twice in the benchmark's
tool step, not in its answer step.

## Running it

`pnpm sim [--seed <n>] [--count <n>] [--forever] [--ticks <n>] [--dump]
[--coverage]` (from the repository's root) runs seeds from `n` (a random one,
printed first, when none is given), stopping at the first that fails, and
prints how to replay it; `--dump` prints each session's log as the run left
it, and `--coverage` how often each kind of action, fault, and outcome
happened across the seeds. `--fixtures <dir>` writes a session format
version's fixture corpus: the sessions three seeds leave that the store serves,
and one made by hand, with how every reader projects them
([sessions.files](../../domains/sessions/files/README.md#format-versions)).

`tests/world.test.ts` runs `LEMMA_HARNESS_RUNS` seeds (default 100) from
`LEMMA_HARNESS_SEED` at `LEMMA_HARNESS_TICKS` ticks (default 120), and fails if
a kind of action, fault, or outcome (a crash part-way through a write, a turn
ending `max-steps`, a prompt answered `unknown`…) never happens across them,
which would be a part of the space the generator stopped reaching. An action
counts once it took effect (a checkout made, a plugin restarted), so one whose
calls all fail is not taken for reached. The rarest kinds happen in about a
tenth of runs, so any 100 seeds reach them all but about once in a thousand. The Soak
workflow runs 2,000 seeds at 200 ticks from a window no earlier night ran (`pnpm
test:random`). `tests/determinism.test.ts` checks a seed leaves the same disk
in another process, starting no timer of the event loop's. Simulated runs name
the date in UTC (`TZ`), so a run is the same on every machine. A seed that
fails saves its evidence (its replay command, the actions it drew, the prompts
and model calls, and its disk) as [`@lemma/testing`](../testing/README.md#failure-evidence)
says.

`tests/failpoints.test.ts` fails a session append and a queue withdrawal at
each of their disk operations in turn, once and from then on
(`SimDisk.faultAfter`), then crashes and restarts the host: what was
acknowledged must be there, and new work must complete.
