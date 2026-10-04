import { Cause, Deferred, Effect, Either, ExecutionStrategy, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { definePlugin, Events, Hooks, PluginContext } from "@lemma/core";
import {
  Agent,
  AgentError,
  HostControl,
  Inspectors,
  InteractionOrigin,
  Llm,
  Paths,
  QueueChanged,
  SessionRemoved,
  Sessions,
  ToolOutput,
  Tools,
} from "@lemma/contracts";
import type { AgentView, ModelInfo, PromptContent, PromptOptions, QueuedPrompt, SessionEvent, TurnOptions } from "@lemma/contracts";
import { LiveTurn } from "./live.ts";
import { planResume } from "./resume.ts";
import { LIVE_INTERVAL_MS, readJournals, readLive, removeLive, removeState, writeJournal, writeLive } from "./state.ts";
import type { Journal } from "./state.ts";
import { newId, runTurn } from "./turn.ts";
import type { TurnReason, TurnResume } from "./turn.ts";

export { basePrompt, environment, titleFrom } from "./prompt.ts";
export type { EnvironmentFacts } from "./prompt.ts";
export { runTurn } from "./turn.ts";

export const AgentConfig = Schema.Struct({
  defaultModel: Schema.optional(Schema.String).annotations({ description: "<provider>/<model> for turns that name none. Absent: the first available model." }),
  systemPrompt: Schema.optional(Schema.String).annotations({ description: "Replaces the default base prompt; the environment section is still added." }),
  cli: Schema.optional(Schema.String).annotations({
    description: "Shell command that runs the lemma CLI; named in the environment section so the agent can inspect itself.",
  }),
  maxSteps: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 200 }).annotations({
    description: "Model calls allowed in one turn before it ends with max-steps.",
  }),
});
export type AgentConfig = typeof AgentConfig.Type;

/** A submitted prompt, queued or placed in a turn. */
interface Item {
  readonly prompt: QueuedPrompt;
  /** Settles when the turn that placed it ends; fails `Withdrawn` when it is taken out of the queue first. */
  readonly done: Deferred.Deferred<void, AgentError>;
  /** A queued steer the running turn is placing: it can no longer be withdrawn. */
  placing: boolean;
}

interface Running {
  readonly turnId: string;
  readonly controller: AbortController;
  /** Epoch ms the turn started (or resumed), for the inspector. */
  readonly startedAt: number;
  /** Set right after the fork; `cancel` waits for it so an early cancel cannot miss the turn. */
  readonly fiber: Deferred.Deferred<Fiber.RuntimeFiber<TurnReason, AgentError>>;
  /** Settles when the turn ends, however it ends. */
  readonly ended: Deferred.Deferred<void, AgentError>;
  readonly live: LiveTurn;
  /** What it was started with; kept in the journal until it ends, so a turn cut off before logging them still has them. */
  readonly prompts: readonly QueuedPrompt[];
  /** The prompts placed in it, by request id. */
  readonly items: Map<string, Item>;
  /** Its body has begun: a cancel interrupts it rather than leaving the flag for it to read. */
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

const userError = (sessionId: string) => (error: { readonly message: string }) =>
  new AgentError({ sessionId, reason: "Session", message: error.message, cause: error });

export default definePlugin({
  id: "agent",
  version: "0.1.0",
  config: AgentConfig,
  provides: [Agent],
  requires: [Sessions, Llm, Tools, HostControl, Paths],
  // Turns resume in the next instance: a reload stops this one (suspending its turns) before starting that one.
  exclusive: true,
  layer: (config) =>
    Layer.scoped(
      Agent,
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const { home } = yield* Paths;
        const services = {
          sessions: yield* Sessions,
          llm: yield* Llm,
          tools: yield* Tools,
          host: yield* HostControl,
          hooks: yield* Hooks,
          events: yield* Events,
          source: owner.id,
        };
        const { sessions, llm, host, events } = services;
        const settings = {
          maxSteps: config.maxSteps,
          ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
          ...(config.cli === undefined ? {} : { cli: config.cli }),
        };

        // Turns belong to the plugin, not the caller: they outlive an interrupted `prompt`. They run in their own scope,
        // and closing the plugin first marks them suspended, so they stay open in the log and resume in the next instance.
        const turns = yield* Scope.fork(yield* Effect.scope, ExecutionStrategy.sequential);
        let suspending = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            suspending = true;
          }),
        );

        const states = new Map<string, SessionState>();
        /**
         * Each session's request ids that are in its log, with the turn that
         * placed them: read from the log once (`loadRequests`), then kept as
         * turns log prompts, so a prompt's exactly-once check never rereads it.
         */
        const requests = new Map<string, Map<string, string | undefined>>();
        const loadedRequests = new Set<string>();
        const requestsOf = (sessionId: string) => {
          let known = requests.get(sessionId);
          if (known === undefined) {
            known = new Map();
            requests.set(sessionId, known);
          }
          return known;
        };
        const indexRequests = (sessionId: string, log: readonly SessionEvent[]) => {
          const known = requestsOf(sessionId);
          for (const event of log) {
            if (event.data.type === "message" && event.data.message.role === "user" && event.data.requestId !== undefined && !known.has(event.data.requestId)) {
              known.set(event.data.requestId, event.data.turnId);
            }
          }
          loadedRequests.add(sessionId);
        };
        const loadRequests = (sessionId: string) =>
          loadedRequests.has(sessionId)
            ? Effect.void
            : Effect.map(sessions.events(sessionId).pipe(Effect.orElseSucceed(() => [])), (log) => indexRequests(sessionId, log));
        const stateOf = (sessionId: string): SessionState => {
          let state = states.get(sessionId);
          if (state === undefined) {
            state = { turn: undefined, queue: [], revision: Date.now(), held: false };
            states.set(sessionId, state);
          }
          return state;
        };
        /** Serializes queue and turn changes: admission, placement, a turn ending and the next starting. */
        const admit = yield* Effect.makeSemaphore(1);
        /** Serializes journal writes, so the last one written is the latest state. */
        const writing = yield* Effect.makeSemaphore(1);

        const journalOf = (state: SessionState): Journal => ({
          ...(state.turn === undefined
            ? {}
            : {
                turn: {
                  turnId: state.turn.turnId,
                  prompts: state.turn.prompts,
                  ...(state.turn.cancelling ? { cancelling: true } : {}),
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
              return yield* llm
                .model(ref)
                .pipe(Effect.mapError((error) => new AgentError({ sessionId, reason: "NoModel", message: error.message, cause: error })));
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
            Effect.zipRight(
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
          requestsOf(sessionId).set(requestId, turnId);
        };

        /** A new turn: the prompts it starts with, the last one's options choosing the model. */
        const fresh = (sessionId: string, entry: Running) =>
          Effect.gen(function* () {
            const info = yield* sessions.get(sessionId).pipe(Effect.mapError(userError(sessionId)));
            const last = entry.prompts[entry.prompts.length - 1]?.options;
            const model = yield* resolveModel(sessionId, last);
            return yield* runTurn(services, settings, {
              sessionId,
              turnId: entry.turnId,
              cwd: info.cwd,
              model,
              prompts: entry.prompts.map(({ requestId, content }) => ({ requestId, content })),
              signal: entry.controller.signal,
              inbox: inboxOf(sessionId, entry),
              live: entry.live,
              logged: loggedIn(sessionId, entry.turnId),
              suspended: () => suspending,
              ...(info.title === undefined ? {} : { title: info.title }),
              ...(last?.thinking === undefined ? {} : { thinking: last.thinking }),
            });
          });

        /** A turn a restart cut off, continued once the composition is up (the tools it may run again are registered). */
        const resumed = (sessionId: string, entry: Running) =>
          Effect.gen(function* () {
            yield* host.composition;
            const cancelling = yield* Effect.sync(() => {
              entry.started = true;
              return entry.cancelling;
            });
            const log = yield* sessions.events(sessionId).pipe(Effect.mapError(userError(sessionId)));
            const resume = planResume(log, entry.turnId);
            // Cut off before its first event: cancelled meanwhile, it never runs.
            if (resume.kind === "not-started") return cancelling ? ("cancelled" as const) : yield* fresh(sessionId, entry);
            if (resume.kind === "ended") {
              const end = log.find((event) => event.data.type === "turn-end" && event.data.turnId === entry.turnId);
              return end?.data.type === "turn-end" ? end.data.reason : "done";
            }
            const { plan } = resume;
            const info = yield* sessions.get(sessionId).pipe(Effect.mapError(userError(sessionId)));
            // The model it ran on, if it still exists; else the default, as a new turn would get.
            const model =
              plan.model === undefined ? yield* resolveModel(sessionId) : yield* llm.model(plan.model).pipe(Effect.orElse(() => resolveModel(sessionId)));
            const restored = yield* readLive(home, sessionId);
            const turnResume: TurnResume = {
              plan,
              cancelling,
              ...(restored?.turnId === entry.turnId ? { restored } : {}),
            };
            return yield* runTurn(services, settings, {
              sessionId,
              turnId: entry.turnId,
              cwd: info.cwd,
              model,
              prompts: entry.prompts.filter((prompt) => !plan.placed.has(prompt.requestId)).map(({ requestId, content }) => ({ requestId, content })),
              resume: turnResume,
              signal: entry.controller.signal,
              inbox: inboxOf(sessionId, entry),
              live: entry.live,
              logged: loggedIn(sessionId, entry.turnId),
              suspended: () => suspending,
              ...(info.title === undefined ? {} : { title: info.title }),
              ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
            });
          });

        /**
         * Starts a turn in the session (under `admit`): it is recorded in the
         * journal before anything reaches the log, with the prompts it starts
         * with, so a crash at any point leaves enough to resume or restart it.
         */
        const start = (
          sessionId: string,
          turnId: string,
          prompts: readonly Item[],
          options: { readonly resume?: boolean; readonly cancelling?: boolean } = {},
        ): Effect.Effect<Running> =>
          Effect.gen(function* () {
            const state = stateOf(sessionId);
            const entry: Running = {
              turnId,
              controller: new AbortController(),
              startedAt: Date.now(),
              fiber: yield* Deferred.make<Fiber.RuntimeFiber<TurnReason, AgentError>>(),
              ended: yield* Deferred.make<void, AgentError>(),
              live: new LiveTurn(turnId),
              prompts: prompts.map((item) => item.prompt),
              items: new Map(prompts.map((item) => [item.prompt.requestId, item])),
              started: options.resume !== true,
              cancelling: options.cancelling ?? false,
            };
            state.turn = entry;
            state.held = false;
            yield* persist(sessionId);
            const body = owner.trace("agent.turn", options.resume === true ? resumed(sessionId, entry) : fresh(sessionId, entry));
            const fiber = yield* Effect.forkIn(
              Effect.interruptible(
                Effect.locally(
                  Effect.gen(function* () {
                    const writer = yield* Effect.fork(keepLive(sessionId, entry.live));
                    return yield* body.pipe(Effect.ensuring(Fiber.interrupt(writer)));
                  }),
                  InteractionOrigin,
                  `session:${sessionId}`,
                ),
              ).pipe(Effect.onExit((exit) => ended(sessionId, entry, exit))),
              turns,
            );
            yield* Deferred.succeed(entry.fiber, fiber);
            return entry;
          });

        /**
         * After a turn's fiber exits: its prompts' callers are answered, and
         * the next queued prompt starts a turn when this one finished. A turn
         * suspended by the agent closing keeps its journal and output, to
         * resume.
         */
        const ended = (sessionId: string, entry: Running, exit: Exit.Exit<TurnReason, AgentError>): Effect.Effect<void> =>
          admit.withPermits(1)(
            Effect.gen(function* () {
              const state = stateOf(sessionId);
              if (state.turn === entry) state.turn = undefined;
              const interrupted = Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause);
              const answer: Exit.Exit<void, AgentError> = Exit.isSuccess(exit) || interrupted ? Exit.void : Exit.asVoid(exit);
              const settle = Effect.forEach([...entry.items.values()], (item) => Deferred.done(item.done, answer), { discard: true }).pipe(
                Effect.zipRight(Deferred.done(entry.ended, answer)),
              );
              if (interrupted && suspending) {
                yield* writeLive(home, sessionId, entry.live.file());
                return yield* settle;
              }
              yield* removeLive(home, sessionId);
              yield* settle;
              // Steers this turn took but did not place (it ended first) can be withdrawn again.
              for (const item of state.queue) item.placing = false;
              const reason: TurnReason = Exit.isSuccess(exit) ? exit.value : interrupted ? "cancelled" : "error";
              const next = state.queue[0];
              if (next !== undefined && (reason === "done" || reason === "max-steps")) {
                setQueue(state, state.queue.slice(1));
                yield* start(sessionId, newId(), [next]);
                yield* queueChanged(sessionId);
                return;
              }
              state.held = state.queue.length > 0;
              yield* persist(sessionId);
            }),
          );

        const prompt = (sessionId: string, content: PromptContent, options: PromptOptions = {}) =>
          Effect.gen(function* () {
            const { requestId } = options;
            // Outside the lock: the first exactly-once check of a session reads its log.
            if (requestId !== undefined) yield* loadRequests(sessionId);
            // Admission cannot be split by the caller's interruption, or a prompt could be queued and forgotten.
            const waitOn = yield* admit.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const state = stateOf(sessionId);
                  if (requestId !== undefined) {
                    const queued = state.queue.find((item) => item.prompt.requestId === requestId);
                    if (queued !== undefined) {
                      // Held after a failed or cancelled turn: the retry starts it, as a new prompt would.
                      if (state.turn === undefined) {
                        const prompts = state.queue;
                        setQueue(state, []);
                        yield* start(sessionId, newId(), prompts);
                      }
                      // Told again, so a client retrying sees its prompt taken.
                      yield* queueChanged(sessionId);
                      return queued.done;
                    }
                    const placed = state.turn?.items.get(requestId);
                    if (placed !== undefined) return placed.done;
                    if (requestsOf(sessionId).has(requestId)) {
                      const running = state.turn;
                      return running !== undefined && requestsOf(sessionId).get(requestId) === running.turnId ? running.ended : undefined;
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
                  yield* sessions.get(sessionId).pipe(Effect.mapError(userError(sessionId)));
                  // Prompts held after a failed or cancelled turn go first, then this one.
                  const item = yield* makeItem(content, options, "follow-up");
                  const prompts = [...state.queue, item];
                  if (state.queue.length > 0) setQueue(state, []);
                  yield* start(sessionId, newId(), prompts);
                  if (prompts.length > 1) yield* queueChanged(sessionId);
                  return item.done;
                }),
              ),
            );
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
            // A resumed turn whose body has not begun reads the flag when it does.
            if (!entry.started) return;
            entry.controller.abort();
            yield* Fiber.interrupt(yield* Deferred.await(entry.fiber));
          });

        const withdraw = (sessionId: string, requestId: string) =>
          admit.withPermits(1)(
            Effect.gen(function* () {
              const state = stateOf(sessionId);
              const item = state.queue.find((candidate) => candidate.prompt.requestId === requestId);
              // Being placed in the running turn: too late to take out.
              if (item === undefined || item.placing) return false;
              setQueue(
                state,
                state.queue.filter((candidate) => candidate !== item),
              );
              yield* Deferred.fail(item.done, new AgentError({ sessionId, reason: "Withdrawn", message: "The prompt was withdrawn from the queue" }));
              yield* persist(sessionId);
              yield* queueChanged(sessionId);
              return true;
            }),
          );

        const view = (sessionId: string): Effect.Effect<AgentView> =>
          Effect.sync(() => {
            const state = stateOf(sessionId);
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
        // A deleted session's queue and journal go with it.
        yield* owner.observe(SessionRemoved, ({ sessionId }) =>
          admit.withPermits(1)(
            Effect.gen(function* () {
              const state = states.get(sessionId);
              if (state?.turn !== undefined) return;
              states.delete(sessionId);
              requests.delete(sessionId);
              loadedRequests.delete(sessionId);
              for (const item of state?.queue ?? []) {
                yield* Deferred.fail(item.done, new AgentError({ sessionId, reason: "Session", message: `Session ${sessionId} was deleted` }));
              }
              yield* removeState(home, sessionId);
            }),
          ),
        );

        // What the last instance left: turns to resume, and queues to run on. Prompts the log already has were placed
        // before it stopped, whatever the journal says.
        for (const [sessionId, journal] of yield* readJournals(home)) {
          const exists = yield* Effect.either(sessions.get(sessionId));
          if (Either.isLeft(exists)) {
            yield* removeState(home, sessionId);
            continue;
          }
          const log = yield* sessions.events(sessionId).pipe(Effect.orElseSucceed(() => []));
          indexRequests(sessionId, log);
          const placed = requestsOf(sessionId);
          const state = stateOf(sessionId);
          state.queue = yield* Effect.forEach(
            journal.queue.filter((prompt) => !placed.has(prompt.requestId)),
            restore,
          );
          state.held = journal.held === true;
          yield* admit.withPermits(1)(
            Effect.gen(function* () {
              if (journal.turn !== undefined) {
                const prompts = yield* Effect.forEach(journal.turn.prompts, restore);
                yield* start(sessionId, journal.turn.turnId, prompts, { resume: true, cancelling: journal.turn.cancelling === true });
                return;
              }
              const next = state.queue[0];
              if (next !== undefined && !state.held) {
                setQueue(state, state.queue.slice(1));
                yield* start(sessionId, newId(), [next]);
                return;
              }
              yield* persist(sessionId);
            }),
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

        return {
          prompt,
          cancel,
          busy: (sessionId: string) => Effect.sync(() => states.get(sessionId)?.turn !== undefined),
          running: Effect.sync(() => [...states].flatMap(([sessionId, state]) => (state.turn === undefined ? [] : [sessionId]))),
          queue: (sessionId: string) => Effect.sync(() => (states.get(sessionId)?.queue ?? []).map((item) => item.prompt)),
          withdraw,
          view,
        };
      }),
    ),
});
