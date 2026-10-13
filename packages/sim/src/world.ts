import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import type { Context } from "effect";
import { Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { HostError } from "@lemma/contracts";
import { callServed } from "@lemma/contracts/testing";
import { Agent } from "@lemma/agent";
import type { PromptOutcome, WhenBusy } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import compaction from "@lemma/context-compaction";
import { SimDisk } from "@lemma/testing";
import { Checker } from "./checker.ts";
import type { Outcome } from "./checker.ts";
import { NO_HOOK_FAULTS, simHooks } from "./hooks.ts";
import type { HookFaults } from "./hooks.ts";
import { HOME, SimHost } from "./host.ts";
import { answerAsSimulated, NO_MODEL_FAULTS, simModel } from "./model.ts";
import type { ModelCall, ModelFaults } from "./model.ts";
import type { Prng } from "./random.ts";
import { Simulation, TimeLimit } from "./simulation.ts";
import { newToolRecord, NO_TOOL_FAULTS, simTools } from "./tools.ts";
import type { ToolFaults } from "./tools.ts";

/** What a client or the world does in a tick: swarm testing turns a random subset on per run, each with its weight. */
export const ACTIONS = [
  "prompt",
  "steer",
  "reject",
  "cancel",
  "withdraw",
  "checkout",
  "retry",
  "newSession",
  "wait",
  "crash",
  "crashMidWrite",
  "stop",
  "restartAgent",
  "restartSessions",
  "restartTools",
  "clockBack",
] as const;
export type Action = (typeof ACTIONS)[number];

/** How the disk fails, each a chance per operation of its kind (`SimDisk.faults`). */
export interface DiskFaults {
  readonly write: number;
  readonly sync: number;
  readonly truncate: number;
  readonly rename: number;
  readonly open: number;
}

export const NO_DISK_FAULTS: DiskFaults = { write: 0, sync: 0, truncate: 0, rename: 0, open: 0 };

/** A run's mix: which actions it takes and how often, and how often each part fails. */
export interface Swarm {
  readonly focus: Focus;
  readonly actions: Readonly<Record<Action, number>>;
  readonly model: ModelFaults;
  readonly tools: ToolFaults;
  readonly hooks: HookFaults;
  readonly disk: DiskFaults;
}

/**
 * Each kind of fault on with chance `on`, at a rate of its own up to `max`: drawn squared, so most runs fail now and
 * then and a few fail often; or, for the part a run focuses on (`even`), drawn evenly, so it often fails often, which
 * is where combinations (a sync and then the cut of its line failing) happen.
 */
const rates = <K extends string>(prng: Prng, kinds: readonly K[], max: number, focused = false): Record<K, number> =>
  Object.fromEntries(kinds.map((kind) => [kind, prng.chance(focused ? 0.9 : 0.5) ? (focused ? prng.next() : prng.next() ** 2) * max : 0])) as Record<K, number>;

/**
 * What a run leans on. A broad run draws every part's faults alike; a focused one draws one part's often and high,
 * with the actions that make its faults matter (a disk's: crashes and restarts) on, as a bug often needs one part
 * failing a lot, not every part a little. Broad runs keep the rest of the space sampled, so the focus does not leave
 * a blind spot (TigerBeetle's "Fuzzer Blind Spots").
 */
export const FOCUSES = ["broad", "disk", "model", "tools", "lifecycle"] as const;
export type Focus = (typeof FOCUSES)[number];

/** The mix a seed draws. Prompts and waits are always on, so every run does something. */
export const drawSwarm = (prng: Prng, focus: Focus = prng.pick(FOCUSES)): Swarm => {
  const drawn = prng.swarm(ACTIONS);
  const at = (kinds: readonly Action[], weight: number) => Object.fromEntries(kinds.map((kind) => [kind, Math.max(drawn[kind], weight)]));
  /** In a disk-focused run only what makes a disk's faults matter: writes, then crashes and restarts to read them back. */
  const only = (kinds: readonly Action[]) => Object.fromEntries(ACTIONS.map((kind) => [kind, kinds.includes(kind) ? drawn[kind] : 0]));
  const actions = {
    ...drawn,
    ...(focus === "disk" ? only(["prompt", "steer", "retry", "newSession", "wait", "crash", "crashMidWrite", "stop"]) : {}),
    ...(focus === "disk" ? at(["crash", "stop"], 10) : {}),
    ...(focus === "lifecycle" ? at(["stop", "restartAgent", "restartSessions", "restartTools", "retry"], 10) : {}),
  };
  return {
    focus,
    actions: { ...actions, prompt: Math.max(actions.prompt, 20), wait: Math.max(actions.wait, 10) } as Record<Action, number>,
    model: rates(
      prng,
      ["transient", "rateLimit", "fatal", "overflow", "stall", "cut", "malformed", "bigUsage"],
      focus === "model" ? 0.5 : 0.2,
      focus === "model",
    ),
    tools: rates(prng, ["fail", "slow"], 0.4, focus === "tools"),
    hooks: rates(prng, ["inputSlow", "inputFail", "inputAnswer", "requestSlow", "requestFail"], 0.3),
    disk: rates(prng, ["write", "sync", "truncate", "rename", "open"], focus === "disk" ? 0.5 : 0.1, focus === "disk"),
  };
};

/** A mix with nothing failing and every action of the workload's clients on: for the benchmark and the liveness phase. */
export const calmSwarm = (actions: Readonly<Record<Action, number>>): Swarm => ({
  focus: "broad",
  actions,
  model: NO_MODEL_FAULTS,
  tools: NO_TOOL_FAULTS,
  hooks: NO_HOOK_FAULTS,
  disk: NO_DISK_FAULTS,
});

export interface WorldOptions {
  readonly seed: number;
  /** Ticks of the safety phase: each takes one action, then lets some simulated time pass. */
  readonly ticks?: number;
  /** Runs fibers' waiting work in an order drawn from the seed. Default: on in half the seeds. */
  readonly shuffle?: boolean;
  /** In place of the seed's mix. */
  readonly swarm?: Swarm;
}

/** A simulated run went wrong: what the checker found, with the seed that replays it. */
export class Violation extends Error {
  override readonly name = "Violation";
}

/** A host of the run, and the signal its clients' calls stop on when it goes. */
interface Running {
  readonly host: SimHost;
  /** Where its plugins serve their channels: clients call through them, as through the transport. */
  readonly registries: Context.Service.Shape<typeof Registries>;
  readonly gone: Deferred.Deferred<void>;
  /** Its clients' calls under way, each with what it is. */
  readonly clients: Map<Fiber.Fiber<unknown, unknown>, string>;
}

/** What a prompt was sent with, to send it again with the same request id. */
interface Prompted {
  readonly sessionId: string;
  readonly requestId: string;
  readonly whenBusy: WhenBusy;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

/**
 * A run of the harness under a workload and faults drawn from a seed: hosts on one simulated disk, each the real
 * sessions store, agent loop, tool registry, and compaction, with the simulated model, tools, and hooks; clients
 * prompting, steering, cancelling, withdrawing, checking out, and retrying; crashes (at once, and part-way through a
 * write), stops, plugin restarts, and the wall clock going back. A safety phase runs with the faults on; then a
 * liveness phase turns them off and requires the run to settle: every prompt whose fate a client did not learn,
 * sent again, is answered; every session is left idle. Then a host started on what was left serves the log the
 * checker audits.
 */
export class World {
  readonly sim: Simulation;
  readonly swarm: Swarm;
  readonly checker: Checker;
  readonly calls: ModelCall[] = [];
  readonly trace: { readonly tick: number; readonly atMs: number; readonly action: Action }[] = [];
  readonly tools = newToolRecord();
  readonly disk: SimDisk;
  private readonly prng: Prng;
  private readonly ticks: number;
  /** The faults in force: the swarm's, or none in the liveness phase. */
  private faults: Swarm;
  private running: Running | undefined;
  private generation = 0;
  private readonly alive = new Set<number>();
  private crashesSeen = 0;
  private readonly sessions: string[] = [];
  private readonly prompted: Prompted[] = [];
  private requests = 0;
  /** Steps a turn may take: few in some runs, so turns end `max-steps`. */
  private readonly maxSteps: number;
  readonly shuffled: boolean;

  constructor(options: WorldOptions) {
    // Shuffled scheduling in odd seeds, so half the runs reorder fibers' work.
    const shuffle = options.shuffle ?? (options.seed & 1) === 1;
    this.shuffled = shuffle;
    this.sim = new Simulation({ seed: options.seed, shuffle });
    this.checker = new Checker({ ordered: !shuffle });
    this.prng = this.sim.random.split("workload");
    this.swarm = options.swarm ?? drawSwarm(this.sim.random.split("swarm"));
    this.faults = this.swarm;
    this.ticks = options.ticks ?? 200;
    this.maxSteps = this.sim.random.split("limits").between(2, 8);
    const diskRandom = this.sim.random.split("disk");
    this.disk = new SimDisk(() => diskRandom.next());
    // A power loss kills the host as it strikes, part-way through a write too: its clients hear nothing more from it.
    this.disk.onCrash = () => {
      if (this.running !== undefined) Deferred.doneUnsafe(this.running.gone, Effect.void);
    };
  }

  /** Runs the safety phase, the liveness phase, and the audit; throws `Violation` on the first problem the checker finds. */
  async run(): Promise<void> {
    await this.start();
    for (let tick = 0; tick < this.ticks; tick++) {
      const action = this.prng.weighted(this.swarm.actions) ?? "wait";
      this.trace.push({ tick, atMs: Number(this.sim.clock.elapsed / 1_000_000n), action });
      await this.act(action);
      await this.advance(this.prng.between(0, 3_000));
      await this.noticeCrash();
      this.raise(`tick ${tick}`);
    }
    await this.settle();
    await this.audit();
    this.raise("the audit");
  }

  /**
   * What the run did that its checks count on, by what it is (`action crash`, `model transient`, `disk sync`, `turn
   * cancelled`…): a kind that never shows up across many seeds is a part of the space no run reaches.
   */
  coverage(): ReadonlyMap<string, number> {
    const seen = new Map(this.checker.seen);
    for (const [operation, count] of this.disk.injected) seen.set(`disk ${operation}`, (seen.get(`disk ${operation}`) ?? 0) + count);
    return seen;
  }

  /** What a seed's run is: its mix and whether its scheduling is shuffled. */
  describe(): string {
    const on = (record: object) =>
      Object.entries(record as Record<string, number>)
        .filter(([, weight]) => weight > 0)
        .map(([kind, weight]) => `${kind} ${weight < 1 ? weight.toFixed(3) : weight}`)
        .join(", ") || "none";
    return [
      `focus: ${this.swarm.focus}, ${this.shuffled ? "shuffled" : "in order"}, at most ${this.maxSteps} steps a turn`,
      `actions: ${on(this.swarm.actions)}`,
      `model faults: ${on(this.swarm.model)}`,
      `tool faults: ${on(this.swarm.tools)}`,
      `hook faults: ${on(this.swarm.hooks)}`,
      `disk faults: ${on(this.swarm.disk)}`,
    ].join("\n");
  }

  private raise(when: string): void {
    if (this.checker.violations.length === 0) return;
    throw new Violation(`seed ${this.sim.seed}, ${when}, at ${this.sim.clock.elapsed / 1_000_000n} ms:\n${this.checker.violations.join("\n")}`);
  }

  /** Lets `millis` of simulated time pass, running what it wakes. */
  private async advance(millis: number): Promise<void> {
    const until = this.sim.clock.elapsed + BigInt(millis) * 1_000_000n;
    await this.sim.settle();
    for (let next = this.sim.clock.nextDeadline(); next !== undefined && next <= until; next = this.sim.clock.nextDeadline()) {
      this.sim.clock.advanceTo(next);
      await this.sim.settle();
    }
    this.sim.clock.advanceTo(until);
    await this.sim.settle();
  }

  /** The plugins a host of this run adds, drawing from the faults in force now. */
  private parts(generation: number): { readonly plugins: readonly Plugin[]; readonly configs: Readonly<Record<string, unknown>> } {
    const faults = this.faults;
    const count = (what: string) => this.checker.count(what);
    const model = simModel(this.sim.random.split(`model ${generation}`), {
      answering: answerAsSimulated(faults.model),
      host: generation,
      calls: this.calls,
      count,
    });
    return {
      plugins: [
        compaction,
        model.plugin,
        simTools(this.sim.random.split(`tools ${generation}`), { faults: faults.tools, record: this.tools, count }).plugin,
        simHooks(this.sim.random.split(`hooks ${generation}`), faults.hooks, count),
        this.checker.observer(),
      ],
      configs: { "agent.loop": { maxSteps: this.maxSteps, stopGrace: this.prng.between(0, 3), retries: 3, retryDelay: 1, maxRetryDelay: 20 } },
    };
  }

  /**
   * Starts the next host on the disk, its disk faults off until it has started, so every host gets going; then reads
   * what the last host left: every event its store reported appended is still there. A crash `crashAfter` scheduled
   * that strikes meanwhile, as a power loss while a host starts can, takes this host too: the next one starts.
   */
  private async start(): Promise<void> {
    for (;;) {
      const generation = ++this.generation;
      this.alive.add(generation);
      Object.assign(this.disk.faults, NO_DISK_FAULTS);
      const crashes = this.disk.crashes;
      const host = await SimHost.start(this.sim, this.disk.mount(), generation, this.parts(generation), this.alive).catch((error: unknown) => {
        if (this.disk.crashes === crashes) throw error;
        return undefined;
      });
      const read = new Map<string, Exit.Exit<readonly SessionEvent[], unknown>>();
      for (const sessionId of host === undefined ? [] : this.sessions) {
        read.set(
          sessionId,
          await host!.run(
            Effect.exit(
              Effect.gen(function* () {
                return yield* (yield* Sessions).events(sessionId);
              }),
            ),
          ),
        );
      }
      if (host === undefined || this.disk.crashes !== crashes) {
        this.checker.count("crash while starting");
        if (host !== undefined) await host.stop();
        this.alive.delete(generation);
        continue;
      }
      for (const [sessionId, events] of read) {
        if (Exit.isFailure(events))
          this.checker.violation(`session ${sessionId}, created, cannot be read after host ${generation - 1}: ${Cause.pretty(events.cause)}`);
        else {
          this.checker.survived(sessionId, events.value);
          // Served now: from here on, they must survive as appended ones do.
          this.checker.served(sessionId, events.value);
        }
      }
      Object.assign(this.disk.faults, this.faults.disk);
      // Every fault as it is reported, an instance a restart replaced since included: a broken assertion is a bug in
      // whichever instance broke it. (What failed a plugin is read as the host stops: `inspect`.)
      this.sim.fork(
        Stream.runForEach(host.core.faults, (fault) =>
          Effect.sync(() => {
            if (Cause.prettyErrors(fault.cause).some((error) => error.name === "AssertionError")) {
              this.checker.violation(`plugin ${fault.pluginId} broke an assertion in host ${generation}: ${Cause.pretty(fault.cause).split("\n")[0]}`);
            }
          }),
        ),
      );
      const registries = await host.run(
        Effect.gen(function* () {
          return yield* Registries;
        }),
      );
      this.running = { host, registries, gone: await this.sim.value(Deferred.make<void>()), clients: new Map() };
      this.crashesSeen = this.disk.crashes;
      return;
    }
  }

  /**
   * Takes the host away: its clients' calls stop answering (they learn nothing more of what they asked), then it
   * stops. Crashed, its disk has crashed already, so nothing it does as it stops reaches the disk.
   */
  private async stop(): Promise<void> {
    const running = this.running;
    if (running === undefined) return;
    this.running = undefined;
    await this.inspect(running.host);
    await this.sim.value(Deferred.succeed(running.gone, undefined));
    await running.host.stop();
    this.alive.delete(running.host.generation);
  }

  /**
   * A plugin fails only from a fault the run injects into it: a broken assertion never, and a disk's only in the store
   * and the agent, which write to it, in a run whose disk fails.
   */
  private async inspect(host: SimHost): Promise<void> {
    const snapshot = await this.sim.value(host.core.inspect);
    const diskFails = Object.values(this.swarm.disk).some((rate) => rate > 0) || this.swarm.actions.crashMidWrite > 0 || this.swarm.actions.crash > 0;
    for (const plugin of snapshot.plugins) {
      const cause = plugin.fault?.cause;
      if (cause !== undefined && Cause.prettyErrors(cause).some((error) => error.name === "AssertionError")) {
        this.checker.violation(`plugin ${plugin.id} broke an assertion: ${Cause.pretty(cause).split("\n")[0]}`);
      }
      if (plugin.state !== "failed") continue;
      const writes = plugin.id === "sessions.files" || plugin.id === "agent.loop";
      if (!(writes && diskFails)) this.checker.violation(`plugin ${plugin.id} failed in host ${host.generation}: ${plugin.fault?.message ?? "no fault"}`);
      this.checker.count(`plugin failed ${plugin.id}`);
    }
  }

  private async crash(): Promise<void> {
    this.disk.crash();
    this.checker.count("crash");
    await this.stop();
    await this.start();
  }

  /** A crash `crashAfter` scheduled may have struck since the last tick, part-way through a write. */
  private async noticeCrash(): Promise<void> {
    if (this.disk.crashes === this.crashesSeen) return;
    this.checker.count("crash mid-write");
    await this.stop();
    await this.start();
  }

  /**
   * A client's call of channel `id` on the current host, made as the transport makes it (`callServed`: a `repeatable`
   * call a reload cut off is made again), on its own; it ends `gone` if the host goes first, the client learning
   * nothing more. `body` turns a call into the client's work (a call, or calls one after another).
   */
  private client<A>(
    label: string,
    body: (call: (id: string, payload: unknown) => Effect.Effect<unknown, unknown>) => Effect.Effect<A, unknown>,
    onEnd: (exit: Exit.Exit<A, unknown> | "gone") => void,
  ): void {
    const running = this.running;
    if (running === undefined) return;
    const call = Effect.raceFirst(
      Effect.map(Effect.exit(body((id, payload) => callServed(running.registries, id, payload))), (exit): Exit.Exit<A, unknown> | "gone" => exit),
      Effect.as(Deferred.await(running.gone), "gone" as const),
    );
    const fiber = this.sim.fork(
      Effect.map(call, (ended) => {
        // A call ends in a result or one of its contract's errors; anything else is a bug (an assertion broken).
        if (ended !== "gone" && Exit.isFailure(ended) && Cause.hasDies(ended.cause)) {
          this.checker.violation(`${label} failed with a defect: ${Cause.pretty(ended.cause).split("\n")[0]}`);
        }
        onEnd(ended);
      }),
    );
    running.clients.set(fiber, label);
    fiber.addObserver(() => running.clients.delete(fiber));
  }

  private sessionFor(): string | undefined {
    return this.sessions.length === 0 ? undefined : this.prng.pick(this.sessions);
  }

  private async newSession(): Promise<void> {
    const running = this.running;
    if (running === undefined || this.sessions.length >= 4) return;
    // A store restarting is briefly not there (`restartSessions`): the session is then not made.
    const created = await running.host.run(
      Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* Sessions).create();
        }),
      ),
    );
    if (Exit.isSuccess(created)) this.sessions.push(created.value.id);
  }

  /** A client sends a prompt, a new one or one it sent before whose fate it never learned. */
  private send(prompted: Prompted): void {
    const { sessionId, requestId, whenBusy } = prompted;
    this.client(
      `prompt ${requestId} (${whenBusy}) in ${sessionId}`,
      (call) => call("agent.prompt", { sessionId, content: text(`prompt ${requestId}`), requestId, whenBusy }) as Effect.Effect<PromptOutcome, unknown>,
      (ended) => {
        const error = ended !== "gone" && Exit.isFailure(ended) ? Cause.squash(ended.cause) : undefined;
        const outcome: Outcome =
          ended === "gone"
            ? { kind: "unknown" }
            : Exit.isSuccess(ended)
              ? { kind: ended.value.kind }
              : // Cut off, or the channel gone (a reload, a restart): the client cannot tell whether it was placed.
                Cause.hasInterruptsOnly(ended.cause) || error instanceof HostError
                ? { kind: "unknown" }
                : { kind: "failed", reason: (error as { readonly reason?: string }).reason ?? "defect" };
        this.checker.outcome(sessionId, requestId, outcome);
      },
    );
  }

  private prompt(whenBusy: WhenBusy, sessionId = this.sessionFor()): void {
    if (sessionId === undefined) return;
    const prompted = { sessionId, requestId: `r${++this.requests}`, whenBusy };
    this.prompted.push(prompted);
    this.send(prompted);
  }

  /** The prompts whose fate their clients have not learned: every call to send them ended unknown, or is still waiting. */
  private unknown(): Prompted[] {
    return this.prompted.filter((prompted) => {
      const sent = this.checker.sent.get(`${prompted.sessionId}/${prompted.requestId}`);
      return sent !== undefined && sent.outcomes.length > 0 && sent.outcomes.every((outcome) => outcome.kind === "unknown");
    });
  }

  private async act(action: Action): Promise<void> {
    this.checker.count(`action ${action}`);
    switch (action) {
      case "newSession":
        return this.newSession();
      case "prompt":
        if (this.sessions.length === 0) return this.newSession();
        return this.prompt("follow-up");
      case "steer":
        return this.prompt("steer");
      case "reject":
        return this.prompt("reject");
      case "retry": {
        const unknown = this.unknown();
        if (unknown.length > 0) {
          this.checker.count("retried");
          this.send(this.prng.pick(unknown));
        }
        return;
      }
      case "cancel": {
        const sessionId = this.sessionFor();
        if (sessionId !== undefined)
          this.client(
            `cancel in ${sessionId}`,
            (call) => call("agent.cancel", { sessionId }),
            () => {},
          );
        return;
      }
      case "withdraw": {
        // Now and then any prompt sent, as a client with a stale list withdraws one (often placed already, or in a
        // session not yet checked against its log); else one of the prompts the session's queue shows.
        if (this.prng.chance(1 / 3)) {
          const prompted = this.prompted.length === 0 ? undefined : this.prng.pick(this.prompted);
          if (prompted === undefined) return;
          this.client(
            `withdraw ${prompted.requestId} in ${prompted.sessionId}`,
            (call) => Effect.orElseSucceed(call("agent.withdraw", { sessionId: prompted.sessionId, requestId: prompted.requestId }), () => false),
            (ended) => {
              if (ended !== "gone" && Exit.isSuccess(ended) && ended.value) this.checker.withdrew(prompted.sessionId, prompted.requestId);
            },
          );
          return;
        }
        const sessionId = this.sessionFor();
        if (sessionId === undefined) return;
        const draw = this.prng.next();
        this.client(
          `withdraw in ${sessionId}`,
          (call) =>
            Effect.gen(function* () {
              const queue = (yield* call("agent.queue", { sessionId })) as readonly { readonly requestId: string }[];
              if (queue.length === 0) return undefined;
              const requestId = queue[Math.floor(draw * queue.length)]!.requestId;
              return (yield* Effect.orElseSucceed(call("agent.withdraw", { sessionId, requestId }), () => false)) ? requestId : undefined;
            }),
          (ended) => {
            if (ended !== "gone" && Exit.isSuccess(ended) && ended.value !== undefined) this.checker.withdrew(sessionId, ended.value);
          },
        );
        return;
      }
      case "checkout": {
        const sessionId = this.sessionFor();
        if (sessionId === undefined) return;
        const draw = this.prng.next();
        this.client(
          `checkout in ${sessionId}`,
          (call) =>
            Effect.gen(function* () {
              const events = (yield* call("sessions.events", { sessionId })) as readonly SessionEvent[];
              if (events.length === 0) return false;
              yield* call("sessions.checkout", { sessionId, eventId: events[Math.floor(draw * events.length)]!.id });
              return true;
            }).pipe(Effect.orElseSucceed(() => false)),
          // Counted once it took effect: a generator whose checkouts all fail would otherwise go on looking busy.
          (ended) => {
            if (ended !== "gone" && Exit.isSuccess(ended) && ended.value) this.checker.count("checked out");
          },
        );
        return;
      }
      case "wait":
        return this.advance(this.prng.between(1_000, 120_000));
      case "crash":
        return this.crash();
      case "crashMidWrite":
        this.disk.crashAfter(this.prng.between(0, 40));
        return;
      case "stop":
        this.checker.count("stop");
        await this.stop();
        return this.start();
      case "restartAgent":
      case "restartSessions":
      case "restartTools": {
        const id = action === "restartAgent" ? "agent.loop" : action === "restartSessions" ? "sessions.files" : "tools.registry";
        const core = this.running?.host.core;
        if (core !== undefined)
          this.client(
            `restart ${id}`,
            () =>
              core.restart(id, { force: true }).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
            (ended) => {
              if (ended !== "gone" && Exit.isSuccess(ended) && ended.value) this.checker.count(`restarted ${id}`);
            },
          );
        return;
      }
      case "clockBack":
        this.sim.clock.stepWall(-this.prng.between(1_000, 3_600_000));
        return;
    }
  }

  /**
   * The liveness phase: nothing fails any more, and a crash still due is called off. A host restarted without faults
   * takes every prompt whose fate its client never learned again, and a new prompt in every session whose queue
   * waits after a failed turn; then every client's call must end, and every session be idle, within two simulated
   * hours.
   */
  private async settle(): Promise<void> {
    this.faults = calmSwarm(this.swarm.actions);
    if (this.disk.crashPending) this.disk.crashAfter(Number.MAX_SAFE_INTEGER);
    await this.noticeCrash();
    await this.stop();
    await this.start();
    for (const prompted of this.unknown()) this.send(prompted);
    const host = this.running!.host;
    for (const sessionId of this.sessions) {
      const queued = await host.run(
        Effect.gen(function* () {
          return yield* Effect.orElseSucceed((yield* Agent).queue(sessionId), () => []);
        }),
      );
      if (queued.length > 0) this.prompt("follow-up", sessionId);
    }
    const clients = this.running!.clients;
    const deadline = this.sim.clock.elapsed + 2n * 60n * 60n * 1_000_000_000n;
    for (;;) {
      await this.sim
        .drive(() => clients.size === 0, Number(deadline / 1_000_000n))
        .catch((error: unknown) => {
          if (!(error instanceof TimeLimit)) throw error;
        });
      const states = await this.idleness(host);
      const busy = states.filter((state) => !state.idle);
      if (clients.size === 0 && busy.length === 0) return;
      if (this.sim.clock.elapsed >= deadline) {
        if (clients.size > 0) this.checker.violation(`liveness: calls never ended: ${[...clients.values()].join("; ")}`);
        for (const state of busy) this.checker.violation(`liveness: session ${state.sessionId} is not idle once the run settled: ${state.what}`);
        return;
      }
      // A turn with no client waiting on it (one resumed) runs on: time passes for it.
      await this.advance(10_000);
    }
  }

  /** Whether each session is idle (no turn running, nothing queued), and if not, what it is doing. */
  private async idleness(host: SimHost): Promise<{ readonly sessionId: string; readonly idle: boolean; readonly what: string }[]> {
    const states = [];
    for (const sessionId of this.sessions) {
      states.push({
        sessionId,
        ...(await host.run(
          Effect.gen(function* () {
            const agent = yield* Agent;
            const busy = yield* agent.busy(sessionId);
            const queue = yield* Effect.orElseSucceed(agent.queue(sessionId), () => []);
            const events = yield* Effect.orElseSucceed((yield* Sessions).events(sessionId), () => []);
            const ends = events.flatMap((event) => (event.data.type === "turn-end" ? [event.data.reason] : []));
            const tail = events
              .slice(-8)
              .map((event) => (event.data.type === "custom" ? `custom ${event.data.kind}` : event.data.type))
              .join(" > ");
            return {
              idle: !busy && queue.length === 0,
              what: `${busy ? "a turn runs" : "no turn runs"}, ${queue.length} queued (${queue.map((prompt) => prompt.requestId).join(", ")}), turns ended ${ends.join(", ")}, the log ends ${tail}`,
            };
          }),
        )),
      });
    }
    return states;
  }

  /** A host started on what the run left serves its log, beside the bytes of its files, for the checker's audit. */
  private async audit(): Promise<void> {
    await this.stop();
    await this.start();
    const host = this.running!.host;
    const served = new Map<string, readonly SessionEvent[]>();
    for (const sessionId of this.sessions) {
      served.set(
        sessionId,
        await host.run(
          Effect.orElseSucceed(
            Effect.gen(function* () {
              return yield* (yield* Sessions).events(sessionId);
            }),
            () => [],
          ),
        ),
      );
    }
    await this.stop();
    this.checker.audit(served, this.fileEvents(), this.calls, this.tools);
  }

  /** Each session's events as its file's bytes parse, a torn last line (no newline) left out. */
  fileEvents(): Map<string, SessionEvent[]> {
    const sessions = new Map<string, SessionEvent[]>();
    for (const file of this.disk.list()) {
      if (!file.startsWith(`${HOME}/sessions/`) || !file.endsWith(".jsonl")) continue;
      // Whole lines only: one without its newline is a write a crash tore, which the store does not serve.
      const lines = (this.disk.read(file) ?? "")
        .split("\n")
        .slice(0, -1)
        .filter((line) => line !== "");
      let id: string | undefined;
      const events: SessionEvent[] = [];
      for (const line of lines) {
        let parsed: { readonly type?: string; readonly id?: string; readonly seq?: number };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.type === "session") id = parsed.id;
        else if (typeof parsed.seq === "number") events.push(parsed as SessionEvent);
      }
      if (id !== undefined) sessions.set(id, events);
    }
    return sessions;
  }
}
