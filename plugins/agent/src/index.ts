import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema, Scope, Semaphore } from "effect";
import type { Context } from "effect";
import { definePlugin, Events, Hooks } from "@lemma/core";
import {
  Agent,
  AgentError,
  Channels,
  HostControl,
  Inspectors,
  InteractionOrigin,
  Llm,
  Paths,
  QueueChanged,
  serveAgent,
  SessionRemoved,
  Sessions,
  ToolOutput,
  Tools,
} from "@lemma/contracts";
import type { AgentView, ModelInfo, PromptContent, PromptOptions, QueuedPrompt, SessionInfo, TurnOptions } from "@lemma/contracts";
import { LiveTurn } from "./live.ts";
import { planResume } from "./resume.ts";
import { makeSlots } from "./slots.ts";
import type { SlotHolder } from "./slots.ts";
import { LIVE_INTERVAL_MS, readJournals, readLive, removeLive, removeState, writeJournal, writeLive } from "./state.ts";
import type { Journal } from "./state.ts";
import { makeRequestIndex } from "./requests.ts";
import { failedAs, newId, runTurn } from "./turn.ts";
import type { TurnOutcome, TurnResume } from "./turn.ts";

const AgentConfig = Schema.Struct({
  defaultModel: Schema.optional(Schema.String).annotate({ description: "<provider>/<model> for turns that name none. Absent: the first available model." }),
  systemPrompt: Schema.optional(Schema.String).annotate({ description: "Replaces the default base prompt; the environment section is still added." }),
  cli: Schema.optional(Schema.String).annotate({
    description: "Shell command that runs the lemma CLI; named in the environment section so the agent can inspect itself.",
  }),
  maxSteps: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 200)))
    .annotate({
      description: "Model calls allowed in one turn before it ends with max-steps.",
    }),
  retries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 10)))
    .annotate({
      description: "Failed model calls asked again in a row (provider errors, rate limits, stalls) before the turn ends in error.",
    }),
  retryDelay: Schema.Number.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 2)))
    .annotate({
      description: "Seconds before the first retry; each later one waits twice as long, up to maxRetryDelay, unless the provider names its own delay.",
    }),
  maxRetryDelay: Schema.Number.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 60)))
    .annotate({
      description: "Seconds the wait between retries grows to, at most.",
    }),
  stopGrace: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20 }))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 5)))
    .annotate({
      description:
        "Seconds a stopping agent (the host stopping, or a reload) lets running tool calls and model calls finish before cutting them off. Turns resume when it starts again.",
    }),
  maxRunning: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 16)))
    .annotate({
      description: "Turns running at once, across sessions; another waits for one to end.",
    }),
});
type AgentConfig = typeof AgentConfig.Type;

/** A submitted prompt, queued or placed in a turn. */
interface Item {
  readonly prompt: QueuedPrompt;
  /** Settles when the turn that placed it ends; fails `Retracted` when it is taken out of the queue first. */
  readonly done: Deferred.Deferred<void, AgentError>;
  /** A queued steer the running turn is placing: it can no longer be withdrawn. */
  placing: boolean;
}

interface Running extends SlotHolder {
  readonly turnId: string;
  readonly controller: AbortController;
  /** Epoch ms the turn started (or resumed), for the inspector. */
  readonly startedAt: number;
  /** Set right after the fork; `cancel` waits for it so an early cancel cannot miss the turn. */
  readonly fiber: Deferred.Deferred<Fiber.Fiber<TurnOutcome, AgentError>>;
  /** Completes on `cancel`: a turn waiting for a slot (or a resumed one for the composition) stops waiting. */
  readonly cancelled: Deferred.Deferred<void>;
  /** Settles when the turn ends, however it ends. */
  readonly ended: Deferred.Deferred<void, AgentError>;
  readonly live: LiveTurn;
  /** What it was started with; kept in the journal until it ends, so a turn cut off before logging them still has them. */
  readonly prompts: readonly QueuedPrompt[];
  /** The prompts placed in it, by request id. */
  readonly items: Map<string, Item>;
  /** It logs an `agent.started` event before running tool calls (every turn this agent starts does; see `Journal`). */
  readonly marked: boolean;
  /**
   * Its body has begun (it had a slot, or was cancelled waiting for one; and a resumed one had the composition): a
   * cancel interrupts it rather than leaving the flag for it to read.
   */
  started: boolean;
  cancelling: boolean;
}

interface SessionState {
  turn: Running | undefined;
  queue: Item[];
  /** Grows with every change to the queue, from the clock so it keeps growing across restarts (see `QueueChanged`). */
  revision: number;
  /** The last turn failed or was cancelled: queued prompts wait for the next one rather than starting a turn. */
  held: boolean;
}

export default definePlugin({
  id: "agent",
  version: "0.1.0",
  config: AgentConfig,
  provides: { agent: Agent },
  requires: { sessions: Sessions, llm: Llm, tools: Tools, host: HostControl, paths: Paths },
  // Turns resume in the next instance: a reload stops this one (suspending its turns) before starting that one.
  exclusive: true,
  // Room for `stopGrace` (at most 20 seconds) and for cutting off what is still running after it.
  deadlines: { dispose: "30 seconds" },
  setup: function* ({ sessions, llm, tools, host, paths }, owner) {
    const config = owner.config;
    const { home } = paths;
    const services = {
      sessions,
      llm,
      tools,
      host,
      hooks: yield* Hooks,
      events: yield* Events,
      source: owner.id,
    };
    const { events } = services;
    const settings = {
      maxSteps: config.maxSteps,
      retries: config.retries,
      retryDelay: config.retryDelay * 1000,
      maxRetryDelay: config.maxRetryDelay * 1000,
      ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
      ...(config.cli === undefined ? {} : { cli: config.cli }),
    };

    // Turns belong to the plugin, not the caller: they outlive an interrupted `prompt`. They run in their own scope,
    // and closing the plugin first marks them suspended, so they stay open in the log and resume in the next instance.
    const turns = yield* Scope.fork(yield* Effect.scope, "parallel");
    let suspending = false;
    /** Completes when the agent starts stopping: turns waiting to ask the model again suspend at once. */
    const stopping = yield* Deferred.make<void>();
    const states = new Map<string, SessionState>();
    // Stopping lets each turn reach its next step or tool call, for `stopGrace`, and suspend itself there; whatever
    // still runs after it is interrupted when the turns' scope closes, as a crash would cut it off.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        suspending = true;
        yield* Deferred.succeed(stopping, undefined);
        const running = [...states.values()].flatMap((state) => (state.turn === undefined ? [] : [state.turn.ended]));
        // Each turn however it ends: one failing does not cut the others' grace short. Interruptible, or the
        // timeout could not fire: finalizers run uninterruptibly.
        yield* Effect.interruptible(
          Effect.forEach(running, (ended) => Effect.exit(Deferred.await(ended)), { concurrency: "unbounded", discard: true }).pipe(
            Effect.timeout(config.stopGrace * 1000),
            Effect.ignore,
          ),
        );
      }),
    );
    /**
     * Turns running at once: a turn waits for a slot before its first event, and gives it up while it waits to
     * ask the model again. When the agent stops, a waiting turn suspends; a cancelled one closes without a slot.
     */
    const slots = makeSlots(config.maxRunning);
    const takeSlot = (entry: Running) =>
      Effect.flatMap(slots.take(entry, Effect.raceFirst(Deferred.await(stopping), Deferred.await(entry.cancelled))), (taken) =>
        taken || !suspending ? Effect.void : Effect.interrupt,
      );
    const inSlot = <A, E, R>(entry: Running, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.ensuring(Effect.andThen(takeSlot(entry), body), slots.release(entry));
    const idle =
      (entry: Running) =>
      <A, E, R>(wait: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.andThen(
          slots.release(entry),
          Effect.tap(wait, () => takeSlot(entry)),
        );

    const requests = makeRequestIndex(sessions);
    /** The session has no turn and nothing queued: what is kept for it goes (its queue revision stays, to keep growing). */
    const forget = (sessionId: string, state: SessionState) => {
      if (state.turn !== undefined || state.queue.length > 0) return;
      requests.drop(sessionId);
    };
    const stateOf = (sessionId: string): SessionState => {
      let state = states.get(sessionId);
      if (state === undefined) {
        state = { turn: undefined, queue: [], revision: Date.now(), held: false };
        states.set(sessionId, state);
      }
      return state;
    };
    /** Serializes queue and turn changes: admission, placement, a turn ending and the next starting. */
    const admit = yield* Semaphore.make(1);
    /**
     * The session held (`Sessions.hold`) for a turn about to start, in a scope `start` closes once the turn has
     * stopped: the session cannot be deleted under it. Fails `Session` when the session is gone. Taken under
     * `admit` only while the session is held already (before admission, or by the turn ending), so it never waits
     * there on a deletion, which would hold up every session.
     */
    const holdFor = (sessionId: string) =>
      Effect.flatMap(Scope.make(), (lease) =>
        sessions.hold(sessionId).pipe(Scope.provide(lease), Effect.as(lease), Effect.mapError(failedAs(sessionId, "Session"))),
      );
    /** Serializes journal writes, so the last one written is the latest state. */
    const writing = yield* Semaphore.make(1);

    const journalOf = (state: SessionState): Journal => ({
      ...(state.turn === undefined
        ? {}
        : {
            turn: {
              turnId: state.turn.turnId,
              prompts: state.turn.prompts,
              ...(state.turn.cancelling ? { cancelling: true } : {}),
              ...(state.turn.marked ? { marked: true } : {}),
            },
          }),
      queue: state.queue.map((item) => item.prompt),
      ...(state.held && state.queue.length > 0 ? { held: true } : {}),
    });
    const persist = (sessionId: string) => writing.withPermits(1)(Effect.suspend(() => writeJournal(home, sessionId, journalOf(stateOf(sessionId)))));
    /** Replaces the queue, moving its revision on with it, so a view never pairs a new queue with an old revision. */
    const setQueue = (state: SessionState, queue: Item[]) => {
      state.queue = queue;
      state.revision = Math.max(state.revision + 1, Date.now());
    };
    const queueChanged = (sessionId: string) =>
      Effect.suspend(() => {
        const state = stateOf(sessionId);
        return events.publish(QueueChanged, { sessionId, queue: state.queue.map((item) => item.prompt), revision: state.revision });
      });

    const resolveModel = (sessionId: string, options?: TurnOptions): Effect.Effect<ModelInfo, AgentError> =>
      Effect.gen(function* () {
        const ref = options?.model ?? config.defaultModel;
        if (ref !== undefined) {
          return yield* llm.model(ref).pipe(Effect.mapError(failedAs(sessionId, "NoModel")));
        }
        const [first] = yield* llm.models({ available: true });
        if (first === undefined) {
          return yield* new AgentError({
            sessionId,
            reason: "NoModel",
            message: "No model is available. Log in to a provider or configure agent.defaultModel.",
          });
        }
        return first;
      });

    const makeItem = (content: PromptContent, options: PromptOptions, mode: QueuedPrompt["mode"]) =>
      Effect.map(Deferred.make<void, AgentError>(), (done): Item => {
        const turnOptions = {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
        };
        return {
          prompt: {
            requestId: options.requestId ?? `p-${newId()}`,
            content,
            mode,
            ...(Object.keys(turnOptions).length === 0 ? {} : { options: turnOptions }),
            at: Date.now(),
          },
          done,
          placing: false,
        };
      });
    const restore = (prompt: QueuedPrompt) => Effect.map(Deferred.make<void, AgentError>(), (done): Item => ({ prompt, done, placing: false }));

    /** The steers the running turn places between steps. Taken for placing, they cannot be withdrawn meanwhile. */
    const inboxOf = (sessionId: string, entry: Running) => ({
      steers: admit.withPermits(1)(
        Effect.sync(() =>
          stateOf(sessionId)
            .queue.filter((item) => item.prompt.mode === "steer")
            .map((item) => {
              item.placing = true;
              return { requestId: item.prompt.requestId, content: item.prompt.content };
            }),
        ),
      ),
      placed: (requestIds: readonly string[]) =>
        admit.withPermits(1)(
          Effect.gen(function* () {
            const state = stateOf(sessionId);
            const placed = new Set(requestIds);
            for (const item of state.queue) if (placed.has(item.prompt.requestId)) entry.items.set(item.prompt.requestId, item);
            setQueue(
              state,
              state.queue.filter((item) => !placed.has(item.prompt.requestId)),
            );
            yield* persist(sessionId);
            yield* queueChanged(sessionId);
          }),
        ),
    });

    /**
     * Writes the running turn's output so far beside the log while it
     * changes. A write in progress finishes before the writer stops, so
     * none lands after the turn's last write or its removal.
     */
    const keepLive = (sessionId: string, live: LiveTurn) =>
      Effect.forever(
        Effect.andThen(
          Effect.sleep(LIVE_INTERVAL_MS),
          Effect.uninterruptible(
            Effect.suspend(() => {
              if (!live.dirty) return Effect.void;
              live.dirty = false;
              return writeLive(home, sessionId, live.file());
            }),
          ),
        ),
      );
    const loggedIn = (sessionId: string, turnId: string) => (requestId: string) => {
      requests.of(sessionId).set(requestId, turnId);
    };

    /** The turn starts running: whether it was cancelled first. */
    const begin = (entry: Running) =>
      Effect.sync(() => {
        entry.started = true;
        return entry.cancelling;
      });
    /** What a turn of `entry` runs with, fresh or resumed, besides its model, its prompts, and where it resumes. */
    const turnInput = (sessionId: string, entry: Running, info: SessionInfo) => ({
      sessionId,
      turnId: entry.turnId,
      cwd: info.cwd,
      signal: entry.controller.signal,
      inbox: inboxOf(sessionId, entry),
      live: entry.live,
      logged: loggedIn(sessionId, entry.turnId),
      suspended: () => suspending,
      stopping: Deferred.await(stopping),
      idle: idle(entry),
      ...(info.title === undefined ? {} : { title: info.title }),
    });

    /** A new turn: the prompts it starts with, the last one's options choosing the model. */
    const fresh = (sessionId: string, entry: Running) =>
      Effect.gen(function* () {
        // Cancelled while it waited for a slot, it never runs, as a queued prompt withdrawn.
        if (yield* begin(entry)) return "cancelled" as const;
        const info = yield* sessions.get(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        const last = entry.prompts[entry.prompts.length - 1]?.options;
        const model = yield* resolveModel(sessionId, last);
        return yield* runTurn(services, settings, {
          ...turnInput(sessionId, entry, info),
          model,
          prompts: entry.prompts.map(({ requestId, content }) => ({ requestId, content })),
          ...(last?.thinking === undefined ? {} : { thinking: last.thinking }),
        });
      });

    /** A turn a restart cut off, continued once the composition is up (the tools it may run again are registered). */
    const resumed = (sessionId: string, entry: Running) =>
      Effect.gen(function* () {
        // Stopping before then, it stays as it is, for the next start. Cancelled, it closes without the tools.
        const ready = yield* Effect.raceAll([
          Effect.as(host.composition, true),
          Effect.as(Deferred.await(entry.cancelled), true),
          Effect.as(Deferred.await(stopping), false),
        ]);
        if (!ready) return yield* Effect.interrupt;
        const cancelling = yield* begin(entry);
        const log = yield* sessions.events(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        const resume = planResume(log, entry.turnId, entry.marked);
        // Cut off before its first event: cancelled meanwhile, it never runs.
        if (resume.kind === "not-started") return cancelling ? ("cancelled" as const) : yield* fresh(sessionId, entry);
        if (resume.kind === "ended") return resume.reason;
        const { plan } = resume;
        const info = yield* sessions.get(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        // The model it ran on, if it still exists; else the default, as a new turn would get.
        const model =
          plan.model === undefined ? yield* resolveModel(sessionId) : yield* llm.model(plan.model).pipe(Effect.catch(() => resolveModel(sessionId)));
        const restored = yield* readLive(home, sessionId);
        const turnResume: TurnResume = {
          plan,
          cancelling,
          ...(restored?.turnId === entry.turnId ? { restored } : {}),
        };
        return yield* runTurn(services, settings, {
          ...turnInput(sessionId, entry, info),
          model,
          prompts: entry.prompts.filter((prompt) => !plan.placed.has(prompt.requestId)).map(({ requestId, content }) => ({ requestId, content })),
          resume: turnResume,
          ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
        });
      });

    /**
     * Starts a turn in the session (under `admit`), holding it with `lease`
     * (`holdFor`) until the turn has stopped. It is recorded in the journal
     * before anything reaches the log, with the prompts it starts with, so a
     * crash at any point leaves enough to resume or restart it.
     */
    const start = (
      sessionId: string,
      turnId: string,
      prompts: readonly Item[],
      lease: Scope.Closeable,
      options: { readonly resume?: boolean; readonly cancelling?: boolean; readonly marked?: boolean } = {},
    ): Effect.Effect<Running> =>
      Effect.gen(function* () {
        const state = stateOf(sessionId);
        const entry: Running = {
          turnId,
          controller: new AbortController(),
          startedAt: Date.now(),
          fiber: yield* Deferred.make<Fiber.Fiber<TurnOutcome, AgentError>>(),
          cancelled: yield* Deferred.make<void>(),
          ended: yield* Deferred.make<void, AgentError>(),
          live: new LiveTurn(turnId),
          prompts: prompts.map((item) => item.prompt),
          items: new Map(prompts.map((item) => [item.prompt.requestId, item])),
          slot: false,
          started: false,
          cancelling: options.cancelling ?? false,
          marked: options.marked ?? true,
        };
        state.turn = entry;
        state.held = false;
        yield* persist(sessionId);
        const body = owner.trace("agent.turn", inSlot(entry, options.resume === true ? resumed(sessionId, entry) : fresh(sessionId, entry)));
        const fiber = yield* Effect.forkIn(
          Effect.interruptible(
            Effect.provideService(
              Effect.gen(function* () {
                const writer = yield* Effect.forkChild(keepLive(sessionId, entry.live));
                return yield* body.pipe(Effect.ensuring(Fiber.interrupt(writer)));
              }),
              InteractionOrigin,
              `session:${sessionId}`,
            ),
          ).pipe(Effect.onExit((exit) => Effect.ensuring(ended(sessionId, entry, exit), Scope.close(lease, Exit.void)))),
          turns,
          // Uninterruptible until the body begins, so `ended` runs, and the hold goes, however early the turn is cut
          // off. The hold goes after `ended`, which holds the session again for the next turn it starts.
          { uninterruptible: true },
        );
        yield* Deferred.succeed(entry.fiber, fiber);
        return entry;
      });

    /**
     * After a turn's fiber exits: its prompts' callers are answered, and
     * the next queued prompt starts a turn when this one finished. A turn
     * left open (suspended by the agent closing, or stopped by the core
     * shutting down) keeps its journal and output, to resume.
     */
    const ended = (sessionId: string, entry: Running, exit: Exit.Exit<TurnOutcome, AgentError>): Effect.Effect<void> =>
      admit.withPermits(1)(
        Effect.gen(function* () {
          const state = stateOf(sessionId);
          if (state.turn === entry) state.turn = undefined;
          const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
          const answer: Exit.Exit<void, AgentError> = Exit.isSuccess(exit) || interrupted ? Exit.void : Exit.asVoid(exit);
          const settle = Effect.forEach([...entry.items.values()], (item) => Deferred.done(item.done, answer), { discard: true }).pipe(
            Effect.andThen(Deferred.done(entry.ended, answer)),
          );
          if ((interrupted && suspending) || (Exit.isSuccess(exit) && exit.value === "suspended")) {
            yield* writeLive(home, sessionId, entry.live.file());
            return yield* settle;
          }
          yield* removeLive(home, sessionId);
          yield* settle;
          // Steers this turn took but did not place (it ended first) can be withdrawn again.
          for (const item of state.queue) item.placing = false;
          const reason: TurnOutcome = Exit.isSuccess(exit) ? exit.value : interrupted ? "cancelled" : "error";
          const next = state.queue[0];
          if (next !== undefined && (reason === "done" || reason === "max-steps")) {
            // This turn holds the session still, so it is not being deleted: only one gone some other way refuses, and
            // the queue then waits for the next prompt, which reports it.
            const lease = yield* Effect.result(holdFor(sessionId));
            if (Result.isSuccess(lease)) {
              setQueue(state, state.queue.slice(1));
              yield* start(sessionId, newId(), [next], lease.success);
              yield* queueChanged(sessionId);
              return;
            }
          }
          state.held = state.queue.length > 0;
          forget(sessionId, state);
          yield* persist(sessionId);
        }),
      );

    const prompt = (sessionId: string, content: PromptContent, options: PromptOptions = {}) =>
      Effect.gen(function* () {
        const { requestId } = options;
        // What the last instance left in the session comes first, as it would have had this one started with it.
        const left = unresumed.get(sessionId);
        if (left !== undefined) yield* recover(sessionId, left);
        // Outside the lock: the first exactly-once check of a session reads its log.
        if (requestId !== undefined) yield* requests.load(sessionId);
        // Held before admission, until it ends, so a wait for the session's deletion to end holds up no other
        // session and can be interrupted.
        const held = sessions.hold(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        // Admission cannot be split by the caller's interruption, or a prompt could be queued and forgotten.
        const admitted = admit.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const state = stateOf(sessionId);
              if (requestId !== undefined) {
                // Dropped meanwhile if the session went idle: read again, under the lock, so the check is complete.
                yield* requests.load(sessionId);
                const queued = state.queue.find((item) => item.prompt.requestId === requestId);
                if (queued !== undefined) {
                  // Held after a failed or cancelled turn: the retry starts it, as a new prompt would.
                  if (state.turn === undefined) {
                    const lease = yield* holdFor(sessionId);
                    const prompts = state.queue;
                    setQueue(state, []);
                    yield* start(sessionId, newId(), prompts, lease);
                  }
                  // Told again, so a client retrying sees its prompt taken.
                  yield* queueChanged(sessionId);
                  return queued.done;
                }
                const placed = state.turn?.items.get(requestId);
                if (placed !== undefined) return placed.done;
                if (requests.of(sessionId).has(requestId)) {
                  const running = state.turn;
                  return running !== undefined && requests.of(sessionId).get(requestId) === running.turnId ? running.ended : undefined;
                }
              }
              if (state.turn !== undefined) {
                const whenBusy = options.whenBusy ?? "follow-up";
                if (whenBusy === "reject") {
                  return yield* new AgentError({ sessionId, reason: "Busy", message: `Session ${sessionId} already has a turn in progress` });
                }
                const item = yield* makeItem(content, options, whenBusy);
                setQueue(state, [...state.queue, item]);
                yield* persist(sessionId);
                yield* queueChanged(sessionId);
                return item.done;
              }
              const lease = yield* holdFor(sessionId);
              // Prompts held after a failed or cancelled turn go first, then this one.
              const item = yield* makeItem(content, options, "follow-up");
              const prompts = [...state.queue, item];
              if (state.queue.length > 0) setQueue(state, []);
              yield* start(sessionId, newId(), prompts, lease);
              if (prompts.length > 1) yield* queueChanged(sessionId);
              return item.done;
            }),
          ),
        );
        const waitOn = yield* Effect.scoped(Effect.andThen(held, admitted));
        // Awaiting, not joining: a caller that goes away leaves the turn running. A cancelled turn resolves normally.
        if (waitOn !== undefined) yield* Deferred.await(waitOn);
      });

    const cancel = (sessionId: string) =>
      Effect.gen(function* () {
        const entry = stateOf(sessionId).turn;
        if (entry === undefined) return;
        // In the journal first: a host that stops while the turn closes resumes it as cancelled.
        entry.cancelling = true;
        yield* persist(sessionId);
        yield* Deferred.succeed(entry.cancelled, undefined);
        // A turn whose body has not begun (waiting for a slot, or a resumed one for the composition) stops waiting,
        // reads the flag, and closes at once.
        if (!entry.started) {
          yield* Effect.exit(Deferred.await(entry.ended));
          return;
        }
        entry.controller.abort();
        yield* Fiber.interrupt(yield* Deferred.await(entry.fiber));
      });

    const withdraw = (sessionId: string, requestId: string) =>
      admit.withPermits(1)(
        Effect.gen(function* () {
          const state = states.get(sessionId);
          const item = state?.queue.find((candidate) => candidate.prompt.requestId === requestId);
          // Being placed in the running turn: too late to take out.
          if (state === undefined || item === undefined || item.placing) return false;
          setQueue(
            state,
            state.queue.filter((candidate) => candidate !== item),
          );
          yield* Deferred.fail(item.done, new AgentError({ sessionId, reason: "Retracted", message: "The prompt was withdrawn from the queue" }));
          forget(sessionId, state);
          yield* persist(sessionId);
          yield* queueChanged(sessionId);
          return true;
        }),
      );

    /**
     * A deleted session's queue and journal go with it. No turn runs in it: each held it (see `holdFor`). It takes no
     * lock but `writing`, whose holders wait on the disk alone, and calls nothing outside the agent.
     */
    const removed = (sessionId: string) =>
      Effect.gen(function* () {
        const state = states.get(sessionId);
        states.delete(sessionId);
        unresumed.delete(sessionId);
        requests.drop(sessionId);
        for (const item of state?.queue ?? []) {
          yield* Deferred.fail(item.done, new AgentError({ sessionId, reason: "Session", message: `Session ${sessionId} was deleted` }));
        }
        // After a journal write under way, which would bring the file back.
        yield* writing.withPermits(1)(removeState(home, sessionId));
      });

    /**
     * The journals the last instance left that this one has not acted on yet (`recover`). One whose session could
     * not be read stays, for the session's next prompt or the next start, rather than be lost.
     */
    const unresumed = new Map<string, Journal>();

    /**
     * Acts on what the last instance left in a session (`unresumed`): resumes its turn, or runs its queue on. Prompts
     * the log has were placed before that instance stopped, whatever the journal says. A session gone takes its state
     * with it; one that cannot be read fails this, its journal kept.
     */
    const recover = (sessionId: string, journal: Journal): Effect.Effect<void, AgentError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const read = yield* Effect.result(
            Effect.gen(function* () {
              yield* sessions.get(sessionId);
              const log = yield* sessions.events(sessionId);
              // Held before admission when a turn may start, as `prompt` holds it.
              if (journal.turn !== undefined || (journal.queue.length > 0 && journal.held !== true)) yield* sessions.hold(sessionId);
              return log;
            }),
          );
          if (Result.isFailure(read) && read.failure.reason !== "NotFound") return yield* failedAs(sessionId, "Session")(read.failure);
          yield* admit.withPermits(1)(
            // Uninterruptible from the hold until the turn has it.
            Effect.uninterruptible(
              Effect.gen(function* () {
                // Acted on meanwhile, or heard deleted.
                if (unresumed.get(sessionId) !== journal) return;
                if (Result.isFailure(read)) return yield* removed(sessionId);
                requests.index(sessionId, read.success);
                const placed = requests.of(sessionId);
                const queue = yield* Effect.forEach(
                  journal.queue.filter((prompt) => !placed.has(prompt.requestId)),
                  restore,
                );
                const { turn } = journal;
                const held = journal.held === true;
                // Before anything changes, as it can fail.
                const lease = turn !== undefined || (queue.length > 0 && !held) ? yield* holdFor(sessionId) : undefined;
                unresumed.delete(sessionId);
                const state = stateOf(sessionId);
                state.queue = queue;
                state.held = held;
                if (lease === undefined) return yield* persist(sessionId);
                if (turn !== undefined) {
                  const prompts = yield* Effect.forEach(turn.prompts, restore);
                  yield* start(sessionId, turn.turnId, prompts, lease, {
                    resume: true,
                    cancelling: turn.cancelling === true,
                    marked: turn.marked === true,
                  });
                  return;
                }
                const next = state.queue.slice(0, 1);
                setQueue(state, state.queue.slice(1));
                yield* start(sessionId, newId(), next, lease);
              }),
            ),
          );
        }),
      );

    const view = (sessionId: string): Effect.Effect<AgentView> =>
      Effect.sync(() => {
        // A session never prompted here gets no state: a view keeps nothing.
        const state = states.get(sessionId) ?? { turn: undefined, queue: [], revision: Date.now(), held: false };
        const queue = { queue: state.queue.map((item) => item.prompt), queueRevision: state.revision };
        return state.turn === undefined ? { output: [], ...queue } : { ...state.turn.live.view(), ...queue };
      });

    // Running tools' output, kept for `view` and for a turn resumed after a crash. Backpressure rather than loss:
    // keeping it is cheap, and a dropped chunk would leave a hole.
    yield* owner.observe(
      ToolOutput,
      ({ sessionId, toolCallId, chunk, offset }) =>
        Effect.sync(() => {
          states.get(sessionId)?.turn?.live.toolOutput(toolCallId, chunk, offset);
        }),
      { buffer: 1024, overflow: "suspend" },
    );
    // Every deletion heard, so no queued prompt's caller waits on a session that is gone: one that finds no room waits
    // for it. Never for good: the store announces a deletion once no hold waits on it, and `removed` takes no lock
    // that a call into the store is made under (not `admit`). One deleted while no instance listened (between two,
    // say) is found gone when the next starts.
    yield* owner.observe(SessionRemoved, ({ sessionId }) => removed(sessionId), { overflow: "suspend" });

    // What the last instance left, acted on now; a session that cannot be read is acted on when it is next prompted,
    // or at the next start.
    const journals = yield* readJournals(home);
    for (const [sessionId, journal] of journals) unresumed.set(sessionId, journal);
    for (const [sessionId, journal] of journals) {
      yield* recover(sessionId, journal).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`agent: could not resume session ${sessionId}: ${error.message}; it resumes when it is next prompted, or the agent starts again`),
        ),
      );
    }

    // What the devtools and `lemma inspect` show of it. Only a view: failing to add it never stops the agent.
    yield* owner
      .add(Inspectors, {
        id: "agent.turns",
        title: "Running turns",
        description: "Each session with a turn running now, how long it has run, and what is queued",
        snapshot: Effect.sync(() =>
          [...states].flatMap(([sessionId, state]) =>
            state.turn === undefined && state.queue.length === 0
              ? []
              : [
                  {
                    session: sessionId,
                    turn: state.turn?.turnId ?? "",
                    started: state.turn === undefined ? "" : new Date(state.turn.startedAt).toISOString(),
                    runningMs: state.turn === undefined ? 0 : Date.now() - state.turn.startedAt,
                    cancelling: state.turn?.cancelling ?? false,
                    queued: state.queue.length,
                  },
                ],
          ),
        ),
      })
      .pipe(Effect.ignore);

    const agent: Context.Service.Shape<typeof Agent> = {
      prompt,
      cancel,
      busy: (sessionId: string) => Effect.sync(() => states.get(sessionId)?.turn !== undefined),
      running: Effect.sync(() => [...states].flatMap(([sessionId, state]) => (state.turn === undefined ? [] : [sessionId]))),
      queue: (sessionId: string) => Effect.sync(() => (states.get(sessionId)?.queue ?? []).map((item) => item.prompt)),
      withdraw,
      view,
    };
    // How clients reach it: the transport serves what `Channels` holds.
    for (const channel of serveAgent(agent, events)) yield* owner.add(Channels, channel);
    return { agent };
  },
});
