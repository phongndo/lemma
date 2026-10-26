import * as os from "node:os";
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Result, Schedule, Schema, Scope, Semaphore } from "effect";
import type { Context } from "effect";
import { assert, awaitable, Events, Hooks, Registries } from "@lemma/core";
import type { PluginSetup } from "@lemma/core";
import { Channels, Inspectors, InteractionOrigin, randomId, secureIds, withContribution } from "@lemma/contracts";
import type { HostControl, Paths } from "@lemma/contracts";
import type { IdSource, ResultCredit } from "@lemma/contracts";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { InProgress } from "@lemma/cli";
import { Agent, AgentError, ModelNotice, PromptSections, QueueChanged, serveAgent } from "../agent.ts";
import type { Llm } from "@lemma/llm";
import { SessionError, SessionRemoved } from "@lemma/sessions";
import type { Sessions } from "@lemma/sessions";
import { ToolOutput } from "@lemma/tools";
import type { ToolRunner } from "@lemma/tools";
import type { AgentView, PromptContent, PromptOptions, PromptOutcome, QueuedPrompt, SectionRequest, SystemSection, TurnOptions } from "../agent.ts";
import type { ModelInfo } from "@lemma/llm";
import type { SessionEvent, SessionInfo, TurnEndReason } from "@lemma/sessions";
import { LiveTurn } from "./live.ts";
import { planResume } from "./resume.ts";
import type { ResumePlan } from "./resume.ts";
import { makeSlots } from "./slots.ts";
import type { SlotHolder } from "./slots.ts";
import { LIVE_INTERVAL_MS, nextInstance, readJournals, readLive, removeLive, writeLive } from "./state.ts";
import type { StateFiles } from "./state.ts";
import { makeRequestIndex } from "./requests.ts";
import { makeInputDecisions } from "./input.ts";
import { admission, makeQueues, REVISIONS_PER_INSTANCE, WITHDRAWN_KEPT } from "./queue.ts";
import type { Item, QueuedTurn, SessionState, Suspended } from "./queue.ts";
import { baseSection, environmentSection } from "./prompt.ts";
import { failedAs, runTurn } from "./turn.ts";
import type { Ended, KeptBranch, Placed, TurnOutcome, TurnResume } from "./turn.ts";

/** The agent's settings: its row's `config`, for `agent.loop` and any loop built on the kit. */
export const AgentConfig = Schema.Struct({
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
  keepCancelled: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    description:
      "What the model wrote before the user stopped its reply stays in what it sees next, as the user read it (text only). Off: logged only for inspection, as an attempt.",
  }),
  parallelTools: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 8)))
    .annotate({
      description: "Calls of one response that run at once, at most, when their tools may run together (read, search); 1 runs every call in turn.",
    }),
  maxRunning: Schema.Int.check(Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 16)))
    .annotate({
      description: "Turns running at once, across sessions; another waits for one to end.",
    }),
});
export type AgentConfig = typeof AgentConfig.Type;

interface Running extends SlotHolder, QueuedTurn {
  readonly controller: AbortController;
  /** Epoch ms the turn started (or resumed), for the inspector. */
  readonly startedAt: number;
  /** Set right after the fork; `cancel` waits for it so an early cancel cannot miss the turn. */
  readonly fiber: Deferred.Deferred<Fiber.Fiber<TurnOutcome, AgentError>>;
  /** Completes on `cancel`: a turn waiting for a slot (or a resumed one for the composition) stops waiting. */
  readonly cancelled: Deferred.Deferred<void>;
  readonly live: LiveTurn;
  readonly items: Map<string, Item>;
  /** It logs an `agent.started` event before running tool calls (every turn this agent starts does; see `Journal`). */
  readonly marked: boolean;
  /**
   * Its body has begun (it had a slot, or was cancelled waiting for one; and a resumed one had the composition): a
   * cancel interrupts it rather than leaving the flag for it to read.
   */
  started: boolean;
  cancelling: boolean;
  /** It resumes only to close so: it had ended, but its `turn-end` had not reached the log. */
  readonly closing: Ended | undefined;
  /** It ended so, but its `turn-end` did not reach the log (`TurnInput.unclosed`): it is kept to be closed so. */
  unclosed: Ended | undefined;
}

/**
 * How a suspended turn resumes, as its log says (`prepare`), with the model it continues on: none when it was being
 * cancelled, as it then only closes, asking nothing.
 */
type Resumption =
  | { readonly kind: "ended"; readonly reason: TurnEndReason }
  | { readonly kind: "not-started"; readonly model: ModelInfo | undefined }
  | { readonly kind: "open"; readonly plan: ResumePlan; readonly model: ModelInfo | undefined };

/** What taking up a restored session needs from the store and the models, read once (`prepare`). */
interface Prepared {
  readonly info: SessionInfo;
  /** Its suspended turn, as it was when read, and how that resumes. */
  readonly turn?: { readonly suspended: Suspended; readonly resumption: Resumption };
}

/** The store said the session does not exist. */
const gone = (error: AgentError): boolean => error.cause instanceof SessionError && error.cause.reason === "NotFound";

const retractedError = (sessionId: string) => new AgentError({ sessionId, reason: "Retracted", message: "The prompt was withdrawn from the queue" });
/** A prompt sent again with the id of one withdrawn: refused, as the first was. */
const retracted = (sessionId: string) => Effect.fail(retractedError(sessionId));

/** A section whose plugin left, with no replacement, while the request was written: no section. */
const GONE = Symbol("gone");

/** Random bytes in a turn's, a step's, or an unnamed prompt's id. */
const ID_BYTES = 6;

/**
 * Sessions whose branch, as their last turn left it, the agent keeps for the next turn to start from, the most recently
 * used: a bound on the memory they hold.
 */
const BRANCHES_KEPT = 16;
/**
 * How long a kept branch stays unused, at most (it goes after half of that at least): a store lets an idle session's
 * events go (`sessions.files` after five minutes, by default), and a branch kept longer would hold them alone, and
 * beside the copy the store reads back when the session is next used.
 */
const BRANCH_IDLE_MS = 5 * 60_000;

/** A queued prompt as a turn places it: what its user message carries, or a plugin's `context` event. */
const placedOf = ({ requestId, content, credit, source, display }: QueuedPrompt): Placed => ({
  requestId,
  content,
  ...(credit === undefined ? {} : { credit }),
  ...(source === undefined ? {} : { source }),
  ...(display === undefined ? {} : { display }),
});

export { MAX_QUEUED, WITHDRAWN_KEPT } from "./queue.ts";

export interface AgentOptions {
  /** Where its journal and live files are: the real file system by default; a simulation passes a simulated disk. */
  readonly fs?: FileSystem;
  /** Where turn, step, and prompt ids' random bytes come from: the system's secure source by default. */
  readonly ids?: IdSource;
  /** The platform the environment section names: this process's (`linux (x64)`) by default. */
  readonly platform?: string;
}

/** What the agent is given: the services it requires. */
export interface AgentDeps {
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  readonly llm: Context.Service.Shape<typeof Llm>;
  readonly tools: Context.Service.Shape<typeof ToolRunner>;
  readonly host: Context.Service.Shape<typeof HostControl>;
  readonly paths: Context.Service.Shape<typeof Paths>;
}

/** The plugin on what `options` gives it, and on this process and its file system for what they leave out. */
/**
 * The agent, as `agent.loop` runs it: the turn loop, its queue and journal, resuming after a restart, its live view,
 * and its channels, inspector, and in-progress report, registered through `owner` (the plugin running it, whose
 * config is `AgentConfig`). Returns the `Agent` service the plugin provides. A loop of another kind builds on the same
 * durability, and shapes its turns with the agent's hooks (`AgentRequestHook`, `AgentContinueHook`).
 */
export const makeAgent = (deps: AgentDeps, owner: PluginSetup<AgentConfig>, options: AgentOptions = {}) =>
  Effect.gen(function* () {
    const { sessions, llm, tools, host, paths } = deps;
    const config = owner.config;
    const files: StateFiles = { home: paths.home, fs: options.fs ?? nodeFileSystem };
    const ids = options.ids ?? secureIds;
    const newId = () => randomId(ids, ID_BYTES);
    /** Where this instance's queue revisions start (see `SessionState.revision`): past every earlier instance's. */
    const instance = yield* nextInstance(files);
    assert(instance * REVISIONS_PER_INSTANCE < Number.MAX_SAFE_INTEGER, `agent instance ${instance} has no room for its revisions`);
    const base = instance * REVISIONS_PER_INSTANCE;
    const registries = yield* Registries;
    // Its own sections, beside any other plugin's.
    yield* owner.add(PromptSections, baseSection(config.systemPrompt), { phase: "base" });
    yield* owner.add(
      PromptSections,
      environmentSection(config.cli, options.platform ?? `${os.platform()} (${os.arch()})`, (ref) =>
        llm.model(ref).pipe(
          Effect.map((model): string | undefined => model.name),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ),
      { phase: "environment" },
    );
    /**
     * Each section's text for the request, as part of its plugin's lifetime: one whose plugin a reload replaced since it
     * was listed is found again by its id, and one whose plugin has left is left out. Empty text (or none) is no section.
     */
    const sections = (request: SectionRequest): Effect.Effect<readonly SystemSection[], AgentError> =>
      Effect.flatMap(registries.items(PromptSections), (items) =>
        Effect.forEach(
          items,
          (listed) => {
            const failed = (message: string, cause?: unknown) =>
              new AgentError({
                sessionId: request.sessionId,
                reason: "Hook",
                message: `The "${listed.item.id}" prompt section from ${listed.pluginId} ${message}`,
                ...(cause === undefined ? {} : { cause }),
              });
            return withContribution(
              registries,
              () => Effect.map(registries.items(PromptSections), (now) => now.find((contribution) => contribution.item.id === listed.item.id)),
              (contribution) =>
                Effect.map(
                  awaitable(() => contribution.item.text(request)),
                  (text: unknown) => ({ contribution, text }),
                ),
              { missing: () => GONE, expired: () => GONE },
            ).pipe(
              Effect.flatMap(({ contribution, text }): Effect.Effect<SystemSection[], AgentError> => {
                if (text === undefined || text === null || text === "") return Effect.succeed([]);
                if (typeof text !== "string") return Effect.fail(failed(`returned ${typeof text}, not text`));
                return Effect.succeed([{ id: contribution.item.id, source: contribution.pluginId, text }]);
              }),
              Effect.catchIf(
                (error) => error === GONE,
                () => Effect.succeed([]),
              ),
              Effect.mapError((cause) =>
                cause instanceof AgentError ? cause : failed(`failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
              ),
            );
          },
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.map((written) => written.flat()));
    const services = {
      sessions,
      llm,
      tools,
      host,
      hooks: yield* Hooks,
      events: yield* Events,
      sections,
      trace: owner.trace,
      newId,
    };
    const { events, hooks } = services;
    const settings = {
      maxSteps: config.maxSteps,
      retries: config.retries,
      retryDelay: config.retryDelay * 1000,
      maxRetryDelay: config.maxRetryDelay * 1000,
      parallelTools: config.parallelTools,
      keepCancelled: config.keepCancelled,
    };

    // Turns belong to the plugin, not the caller: they outlive an interrupted `prompt`. They run in their own scope,
    // and closing the plugin first marks them suspended, so they stay open in the log and resume in the next instance.
    const turns = yield* Scope.fork(yield* Effect.scope, "parallel");
    let suspending = false;
    /** Completes when the agent starts stopping: turns waiting to ask the model again suspend at once. */
    const stopping = yield* Deferred.make<void>();
    /** Each session's queue and turn, journaled. */
    const queues = makeQueues<Running>(files, base);
    const { of: stateOf, setQueue, persistOrWarn, recorded } = queues;
    // Stopping lets each turn reach its next step or tool call, for `stopGrace`, and suspend itself there; whatever
    // still runs after it is interrupted when the turns' scope closes, as a crash would cut it off.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        suspending = true;
        yield* Deferred.succeed(stopping, undefined);
        const running = [...queues.all()].flatMap(([, state]) => (state.turn === undefined ? [] : [state.turn.ended]));
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
    /**
     * Each session's branch as its last turn left it, until the next takes it, the most recently kept last
     * (`BRANCHES_KEPT`), and whether it was kept since the last sweep (`BRANCH_IDLE_MS`).
     */
    const branches = new Map<string, { readonly kept: KeptBranch; fresh: boolean }>();
    const kept = (sessionId: string) => ({
      take: () => {
        const entry = branches.get(sessionId);
        branches.delete(sessionId);
        return entry?.kept;
      },
      keep: (branch: KeptBranch) => {
        branches.delete(sessionId);
        branches.set(sessionId, { kept: branch, fresh: true });
        for (const oldest of branches.keys()) {
          if (branches.size <= BRANCHES_KEPT) break;
          branches.delete(oldest);
        }
      },
    });
    // A branch kept before the last sweep, and not taken since, goes: one unused for between half of `BRANCH_IDLE_MS` and all of it.
    yield* owner.background(
      "forget idle branches",
      Effect.repeat(
        Effect.sync(() => {
          for (const [sessionId, entry] of branches) {
            if (entry.fresh) entry.fresh = false;
            else branches.delete(sessionId);
          }
        }),
        Schedule.spaced(Duration.millis(BRANCH_IDLE_MS / 2)),
      ),
    );
    /** The session has no turn and nothing queued: what is kept for it goes (its queue revision stays, to keep growing). */
    const forget = (sessionId: string, state: SessionState<Running>) => {
      if (state.turn !== undefined || state.suspended !== undefined || state.queue.length > 0) return;
      requests.drop(sessionId);
    };
    /** Serializes queue and turn changes: admission, placement, a turn ending and the next starting. */
    const admit = yield* Semaphore.make(1);
    /**
     * The session held (`Sessions.hold`) for a turn about to start, in a scope `start` closes once the turn has
     * stopped: the session cannot be deleted under it. Fails `Session` when the session is gone. Taken under
     * `admit` only while the session is held already (before admission, by `ready`, or by the turn ending), so it
     * never waits there on a deletion, which would hold up every session.
     */
    const holdFor = (sessionId: string) =>
      Effect.flatMap(Scope.make(), (lease) =>
        sessions.hold(sessionId).pipe(Scope.provide(lease), Effect.as(lease), Effect.mapError(failedAs(sessionId, "Session"))),
      );
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
            message: "No model is available. Log in to a provider or set agent.loop's defaultModel.",
          });
        }
        return first;
      });

    const makeItem = (content: PromptContent, options: PromptOptions, mode: QueuedPrompt["mode"], credit?: ResultCredit) =>
      Effect.gen(function* () {
        const turnOptions = {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
          ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
        };
        const item: Item = {
          prompt: {
            requestId: options.requestId ?? `p-${newId()}`,
            content,
            mode,
            ...(Object.keys(turnOptions).length === 0 ? {} : { options: turnOptions }),
            at: yield* Clock.currentTimeMillis,
            ...(credit === undefined ? {} : { credit }),
            ...(options.source === undefined ? {} : { source: options.source }),
            ...(options.source === undefined || options.display === undefined ? {} : { display: options.display }),
          },
          done: yield* Deferred.make<void, AgentError>(),
          placing: false,
        };
        return item;
      });

    /** The steers the running turn places between steps. Taken for placing, they cannot be withdrawn meanwhile. */
    const inboxOf = (sessionId: string, entry: Running) => ({
      steers: admit.withPermits(1)(
        Effect.sync(() =>
          stateOf(sessionId)
            .queue.filter((item) => item.prompt.mode === "steer")
            .map((item) => {
              item.placing = true;
              return placedOf(item.prompt);
            }),
        ),
      ),
      placed: (requestIds: readonly string[]) =>
        admit.withPermits(1)(
          Effect.gen(function* () {
            const state = stateOf(sessionId);
            const placed = new Set(requestIds);
            for (const item of state.queue) if (placed.has(item.prompt.requestId)) entry.items.set(item.prompt.requestId, item);
            yield* setQueue(
              state,
              state.queue.filter((item) => !placed.has(item.prompt.requestId)),
            );
            // Placed in the log already: the next start finds them there, whatever the journal says.
            yield* persistOrWarn(sessionId);
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
              return writeLive(files, sessionId, live.file());
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
      kept: kept(sessionId),
      unclosed: (ended: Ended) => void (entry.unclosed = ended),
      ...(info.title === undefined ? {} : { title: info.title }),
    });

    /** A new turn: the prompts it starts with, the last one's options choosing the model. */
    const fresh = (sessionId: string, entry: Running) =>
      Effect.gen(function* () {
        // Cancelled while it waited for a slot, it never runs, as a queued prompt withdrawn.
        if (yield* begin(entry)) return "cancelled" as const;
        const info = yield* sessions.get(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        return yield* begun(sessionId, entry, info, yield* resolveModel(sessionId, entry.prompts.at(-1)?.options));
      });
    /** A new turn, begun, on `model`. */
    const begun = (sessionId: string, entry: Running, info: SessionInfo, model: ModelInfo) => {
      const thinking = entry.prompts.at(-1)?.options?.thinking;
      const plugins = entry.prompts.at(-1)?.options?.plugins;
      return runTurn(services, settings, {
        ...turnInput(sessionId, entry, info),
        model,
        prompts: entry.prompts.map(placedOf),
        ...(thinking === undefined ? {} : { thinking }),
        ...(plugins === undefined ? {} : { plugins }),
      });
    };

    /**
     * A turn a restart cut off, continued once the composition is up (the tools it may run again are registered), as
     * `prepare` read it: nothing it needed from the store or the models is left to fail before it runs.
     */
    const resumed = (sessionId: string, entry: Running, info: SessionInfo, resumption: Resumption) =>
      Effect.gen(function* () {
        // Stopping before then, it stays as it is, for the next start. Cancelled, it closes without the tools.
        const up = yield* Effect.raceAll([
          Effect.as(host.composition, true),
          Effect.as(Deferred.await(entry.cancelled), true),
          Effect.as(Deferred.await(stopping), false),
        ]);
        if (!up) return yield* Effect.interrupt;
        const cancelling = yield* begin(entry);
        // Cut off before its first event: cancelled meanwhile, it never runs. (It has no model only if cancelled.)
        if (resumption.kind === "not-started") {
          if (entry.closing !== undefined) return entry.closing.reason;
          return cancelling || resumption.model === undefined ? ("cancelled" as const) : yield* begun(sessionId, entry, info, resumption.model);
        }
        if (resumption.kind === "ended") return resumption.reason;
        const { plan, model } = resumption;
        const restored = yield* readLive(files, sessionId);
        const turnResume: TurnResume = {
          plan,
          cancelling,
          ...(restored?.turnId === entry.turnId ? { restored } : {}),
          ...(entry.closing === undefined ? {} : { closing: entry.closing }),
        };
        return yield* runTurn(services, settings, {
          ...turnInput(sessionId, entry, info),
          ...(model === undefined ? {} : { model }),
          prompts: entry.prompts.filter((prompt) => !plan.placed.has(prompt.requestId)).map(placedOf),
          resume: turnResume,
          ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
          ...(plan.plugins === undefined ? {} : { plugins: plan.plugins }),
        });
      });

    /**
     * Starts a turn in the session (under `admit`), holding it with `lease`
     * (`holdFor`) until the turn has stopped. It is recorded in the journal
     * before anything reaches the log, with the prompts it starts with, and
     * with what `taking` changes of the session's state for it (the queue it
     * takes them from), so a crash at any point leaves enough to resume or
     * restart it. A new turn the journal cannot record does not start: this
     * fails `Io`, the session as it was (`recorded`) and the lease closed.
     */
    const start = (
      sessionId: string,
      turnId: string,
      prompts: readonly Item[],
      lease: Scope.Closeable,
      options: {
        /** It resumes, as `prepare` read it. */
        readonly resume?: { readonly info: SessionInfo; readonly resumption: Resumption };
        readonly cancelling?: boolean;
        readonly marked?: boolean;
        readonly closing?: Ended;
        readonly taking?: (state: SessionState<Running>) => Effect.Effect<void>;
      } = {},
    ): Effect.Effect<Running, AgentError> =>
      Effect.gen(function* () {
        const entry: Running = {
          turnId,
          controller: new AbortController(),
          startedAt: yield* Clock.currentTimeMillis,
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
          closing: options.closing,
          unclosed: undefined,
        };
        const { resume } = options;
        const occupy = (state: SessionState<Running>) =>
          Effect.andThen(
            options.taking?.(state) ?? Effect.void,
            Effect.sync(() => {
              assert(state.turn === undefined, `session ${sessionId} starts turn ${turnId} while turn ${state.turn?.turnId} runs`);
              assert(state.suspended === undefined, `session ${sessionId} starts turn ${turnId} while one is suspended`);
              state.turn = entry;
              // One that only closes runs no queue on if it was held (see `ended`).
              if (options.closing === undefined) state.held = false;
            }),
          );
        // A resumed turn is in the journal already, as the last instance left it.
        if (resume !== undefined) yield* Effect.andThen(occupy(stateOf(sessionId)), persistOrWarn(sessionId));
        else yield* recorded(sessionId, occupy).pipe(Effect.tapError(() => Scope.close(lease, Exit.void)));
        const body = owner.trace(
          "agent.turn",
          inSlot(entry, resume === undefined ? fresh(sessionId, entry) : resumed(sessionId, entry, resume.info, resume.resumption)),
        );
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
          assert(state.turn === entry || state.turn === undefined, `session ${sessionId} ran turn ${state.turn?.turnId} beside ${entry.turnId}`);
          if (state.turn === entry) state.turn = undefined;
          const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
          const answer: Exit.Exit<void, AgentError> = Exit.isSuccess(exit) || interrupted ? Exit.void : Exit.asVoid(exit);
          // A prompt a cancelled turn never placed (it was cancelled before it began) did not run: its call hears so, as
          // a withdrawn one's does, rather than that it was placed.
          const cancelled = (Exit.isSuccess(exit) && exit.value === "cancelled") || (interrupted && !suspending);
          const answerFor = (item: Item): Exit.Exit<void, AgentError> =>
            cancelled && requests.of(sessionId).get(item.prompt.requestId) !== entry.turnId
              ? Exit.fail(new AgentError({ sessionId, reason: "Retracted", message: "The turn was cancelled before it placed the prompt" }))
              : answer;
          const settle = Effect.forEach([...entry.items.values()], (item) => Deferred.done(item.done, answerFor(item)), { discard: true }).pipe(
            Effect.andThen(Deferred.done(entry.ended, answer)),
          );
          // Remembered as a withdrawn prompt is, before its caller hears: sent again (a client that never heard), it is
          // refused, not placed.
          // (One that only closes did so when it ended.)
          const retractedIds =
            cancelled && entry.closing === undefined
              ? [...entry.items.values()].filter((item) => Exit.isFailure(answerFor(item))).map((item) => item.prompt.requestId)
              : [];
          if (retractedIds.length > 0) {
            state.withdrawn = [...state.withdrawn, ...retractedIds].slice(-WITHDRAWN_KEPT);
            // Written as the turn will end it: a cancelled turn runs no queue on, which waits for the next prompt.
            state.held = state.queue.length > 0;
            yield* persistOrWarn(sessionId);
          }
          if ((interrupted && suspending) || (Exit.isSuccess(exit) && exit.value === "suspended")) {
            yield* writeLive(files, sessionId, entry.live.file());
            return yield* settle;
          }
          const runsOn = (reason: TurnOutcome) => reason === "done" || reason === "max-steps";
          const { unclosed } = entry;
          if (unclosed !== undefined) {
            // It ended, but not in the log: kept in the journal, suspended, before its callers hear, it is closed so
            // when its session is next taken up (prompted, cancelled, or at the next start), and the queue then runs
            // on as it would have now. Without its prompts, as any turn that ended: one sent again is found in the log
            // if the turn placed it, and is a new prompt if not, rather than waiting on a close that will not place it.
            yield* writeLive(files, sessionId, entry.live.file());
            state.suspended = {
              turnId: entry.turnId,
              prompts: [],
              marked: entry.marked,
              cancelling: entry.cancelling,
              closing: unclosed,
            };
            state.restored = true;
            state.held = state.queue.length > 0 && !runsOn(unclosed.reason);
            state.ranToEnd = runsOn(unclosed.reason);
            for (const item of state.queue) item.placing = false;
            yield* persistOrWarn(sessionId);
            return yield* settle;
          }
          yield* removeLive(files, sessionId);
          yield* settle;
          // Steers this turn took but did not place (it ended first) can be withdrawn again.
          for (const item of state.queue) item.placing = false;
          const reason: TurnOutcome = Exit.isSuccess(exit) ? exit.value : interrupted ? "cancelled" : "error";
          state.ranToEnd = runsOn(reason);
          const next = state.queue[0];
          // One that only closes ended before: the queue runs on unless that held it, and a prompt since let it go.
          if (next !== undefined && (entry.closing === undefined ? runsOn(reason) : !state.held)) {
            // This turn holds the session still, so it is not being deleted: only one gone some other way refuses, and
            // the queue then waits for the next prompt, which reports it.
            const lease = yield* Effect.result(holdFor(sessionId));
            if (Result.isSuccess(lease)) {
              const started = yield* Effect.result(
                start(sessionId, newId(), [next], lease.success, { taking: (state) => setQueue(state, state.queue.slice(1)) }),
              );
              if (Result.isSuccess(started)) {
                yield* queueChanged(sessionId);
                return;
              }
              // Not recorded, so not started: the queue waits, as the next prompt or a retry will tell its caller.
              yield* Effect.logWarning(`agent: ${started.failure.message}; the queue waits for the next prompt`);
            }
          }
          state.held = state.queue.length > 0;
          forget(sessionId, state);
          yield* persistOrWarn(sessionId);
        }),
      );

    /** What `AgentInputHook` made of prompts (see `makeInputDecisions`). */
    const decisions = makeInputDecisions(hooks);

    const prompt = (sessionId: string, content: PromptContent, options: PromptOptions = {}) =>
      Effect.gen(function* () {
        const { requestId } = options;
        // Outside the lock: the first exactly-once check of a session reads its log.
        if (requestId !== undefined) yield* requests.load(sessionId);
        // A new prompt goes through `AgentInputHook` first, outside the lock (a handler may take its time). One placed
        // already, an exactly-once retry, answers as it did; two retries racing may both ask, and the lock places one.
        const state = queues.get(sessionId);
        // One withdrawn is known too, though not refused here: a withdrawal is final once its journal write is, which
        // the check under the lock sees.
        const known =
          requestId !== undefined &&
          (requests.of(sessionId).has(requestId) ||
            state?.withdrawn.includes(requestId) === true ||
            state?.queue.some((item) => item.prompt.requestId === requestId) === true ||
            state?.turn?.items.has(requestId) === true ||
            state?.suspended?.prompts.some((item) => item.prompt.requestId === requestId) === true);
        const decided = known ? { kind: "place" as const, content, options } : yield* decisions.decide(sessionId, content, options);
        if (decided.kind !== "place") return decided;
        const placing = decided.content;
        const placingOptions = decided.options;
        const credit = "credit" in decided ? decided.credit : undefined;
        // Admission cannot be split by the caller's interruption, or a prompt could be queued and forgotten.
        const admitted = (prepared: Prepared | undefined) =>
          admit.withPermits(1)(
            Effect.uninterruptible(
              Effect.gen(function* () {
                // What the last instance left runs first, as it would have had this one started with it.
                if (prepared !== undefined) yield* reopen(sessionId, prepared);
                const state = stateOf(sessionId);
                if (requestId !== undefined) {
                  if (state.withdrawn.includes(requestId)) return yield* retracted(sessionId);
                  // Dropped meanwhile if the session went idle: read again, under the lock, so the check is complete.
                  yield* requests.load(sessionId);
                }
                const whenBusy = placingOptions.whenBusy ?? "follow-up";
                const admitting = admission(sessionId, state, { requestId, whenBusy }, requests.of(sessionId));
                switch (admitting.kind) {
                  case "queued":
                    // Held after a failed or cancelled turn: the retry starts it, as a new prompt would (not a
                    // plugin's, which waits with it).
                    if (admitting.start && placingOptions.source === undefined) {
                      const lease = yield* holdFor(sessionId);
                      yield* start(sessionId, newId(), state.queue, lease, { taking: (taken) => setQueue(taken, []) });
                    }
                    // Told again, so a client retrying sees its prompt taken.
                    yield* queueChanged(sessionId);
                    return admitting.item.done;
                  case "placed":
                    return admitting.done;
                  case "logged":
                    return admitting.ended;
                  case "busy":
                    return yield* new AgentError({ sessionId, reason: "Busy", message: admitting.message });
                  case "queue": {
                    const item = yield* makeItem(placing, placingOptions, whenBusy === "reject" ? "follow-up" : whenBusy, credit);
                    // Accepted once it is in the journal, as a crash would lose it otherwise.
                    yield* recorded(sessionId, (queued) =>
                      Effect.andThen(
                        setQueue(queued, [...queued.queue, item]),
                        Effect.sync(() => {
                          // Behind a turn that only closes one that ended before, a person's new prompt lets go of a
                          // queue that ended held, as it would have had the turn closed then. A plugin's does not.
                          if (queued.turn?.closing !== undefined && placingOptions.source === undefined) queued.held = false;
                        }),
                      ),
                    );
                    yield* queueChanged(sessionId);
                    return item.done;
                  }
                  case "start": {
                    // A plugin's prompt starts a turn only after one that ran to its end, with nothing held: one the
                    // user stopped, or that failed, stays stopped, and the prompt waits, held, for theirs.
                    if (placingOptions.source !== undefined && !(state.ranToEnd && state.queue.length === 0)) {
                      const item = yield* makeItem(placing, placingOptions, "follow-up", credit);
                      yield* recorded(sessionId, (queued) =>
                        Effect.andThen(
                          setQueue(queued, [...queued.queue, item]),
                          Effect.sync(() => void (queued.held = true)),
                        ),
                      );
                      yield* queueChanged(sessionId);
                      return item.done;
                    }
                    const lease = yield* holdFor(sessionId);
                    // Prompts held after a failed or cancelled turn go first, then this one.
                    const item = yield* makeItem(placing, placingOptions, "follow-up", credit);
                    const prompts = [...state.queue, item];
                    yield* start(sessionId, newId(), prompts, lease, { taking: (taken) => (taken.queue.length > 0 ? setQueue(taken, []) : Effect.void) });
                    if (prompts.length > 1) yield* queueChanged(sessionId);
                    return item.done;
                  }
                }
              }),
            ),
          );
        // Placed (or found placed): known by where it is from now on, so its decision is let go.
        const waitOn = yield* Effect.scoped(Effect.flatMap(ready(sessionId), admitted)).pipe(
          Effect.ensuring(Effect.sync(() => decisions.forget(sessionId, requestId))),
        );
        // Awaiting, not joining: a caller that goes away leaves the turn running. A cancelled turn resolves normally.
        if (waitOn !== undefined) yield* Deferred.await(waitOn);
        return { kind: "placed" } satisfies PromptOutcome;
      });

    /**
     * Marks the turn cancelling, in the journal, and stops it, as one step the caller's interruption cannot split (a
     * flag set and never acted on would close the turn as cancelled only when it next resumes); then waits for it to
     * close, which the caller may stop waiting for.
     */
    const cancel = (sessionId: string) =>
      Effect.gen(function* () {
        const suspended = queues.get(sessionId)?.suspended;
        if (suspended !== undefined) {
          // Not running: marked in the journal, it closes as cancelled when it resumes, asking the model nothing. Now,
          // if the session can be taken up.
          yield* admit.withPermits(1)(
            Effect.uninterruptible(
              Effect.suspend(() => {
                suspended.cancelling = true;
                return persistOrWarn(sessionId);
              }),
            ),
          );
          yield* resume(sessionId).pipe(Effect.catch(notTakenUp(sessionId)));
        }
        const entry = stateOf(sessionId).turn;
        if (entry === undefined) return;
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // In the journal first: a host that stops while the turn closes resumes it as cancelled.
            entry.cancelling = true;
            yield* persistOrWarn(sessionId);
            yield* Deferred.succeed(entry.cancelled, undefined);
            // A turn whose body has not begun (waiting for a slot, or a resumed one for the composition) stops
            // waiting, reads the flag, and closes at once.
            if (!entry.started) return yield* restore(Effect.exit(Deferred.await(entry.ended)));
            entry.controller.abort();
            const fiber = yield* Deferred.await(entry.fiber);
            // Interrupted by the agent's own fiber, so the turn is stopped however soon the caller stops waiting.
            yield* Effect.forkIn(Fiber.interrupt(fiber), turns);
            yield* restore(Fiber.await(fiber));
          }),
        );
      });

    const withdraw = (sessionId: string, requestId: string) =>
      Effect.andThen(
        checked(sessionId),
        // Not split by the caller's interruption, as admission is not: a prompt taken out of the queue and never answered
        // would leave its caller waiting for good.
        admit.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const state = queues.get(sessionId);
              const item = state?.queue.find((candidate) => candidate.prompt.requestId === requestId);
              // Being placed in the running turn: too late to take out.
              if (state === undefined || item === undefined || item.placing) return false;
              // Withdrawn once the journal no longer has it, and remembers it, as a crash would bring it back otherwise.
              yield* recorded(sessionId, (from) =>
                Effect.andThen(
                  setQueue(
                    from,
                    from.queue.filter((candidate) => candidate !== item),
                  ),
                  Effect.sync(() => void (from.withdrawn = [...from.withdrawn, requestId].slice(-WITHDRAWN_KEPT))),
                ),
              );
              yield* Deferred.fail(item.done, retractedError(sessionId));
              forget(sessionId, state);
              yield* queueChanged(sessionId);
              return true;
            }),
          ),
        ),
      );

    /**
     * Makes a queued follow-up a steer in its place, with its caller's `done`: the running turn places it after its
     * current step. With no turn running (the queue held, or the turn suspended), it waits as a follow-up would. Made
     * once the journal has it, as admission is, and not split by the caller's interruption.
     */
    const promote = (sessionId: string, requestId: string) =>
      Effect.andThen(
        checked(sessionId),
        admit.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const state = queues.get(sessionId);
              const item = state?.queue.find((candidate) => candidate.prompt.requestId === requestId);
              if (state?.turn === undefined || item === undefined || item.prompt.mode !== "follow-up") return false;
              const steer: Item = { prompt: { ...item.prompt, mode: "steer" }, done: item.done, placing: false };
              yield* recorded(sessionId, (from) =>
                setQueue(
                  from,
                  from.queue.map((candidate) => (candidate === item ? steer : candidate)),
                ),
              );
              yield* queueChanged(sessionId);
              return true;
            }),
          ),
        ),
      );

    /**
     * A deleted session's queue, suspended turn and journal go with it. No turn runs in it: each held it (see
     * `holdFor`). It takes no lock but the journal's writes, whose holders wait on the disk alone, and calls nothing
     * outside the agent.
     */
    const removed = (sessionId: string) =>
      Effect.gen(function* () {
        const state = queues.drop(sessionId);
        requests.drop(sessionId);
        branches.delete(sessionId);
        for (const item of state?.queue ?? []) {
          yield* Deferred.fail(item.done, new AgentError({ sessionId, reason: "Session", message: `Session ${sessionId} was deleted` }));
        }
        yield* queues.removeFiles(sessionId);
      });

    /**
     * Checks a restored session's queue against its log (under `admit`), which is all it needs: queued prompts the
     * log has were placed before the last instance stopped, whatever the journal said, so they leave the queue.
     */
    const reconcile = (sessionId: string, log: readonly SessionEvent[]) =>
      Effect.gen(function* () {
        const state = queues.get(sessionId);
        if (state === undefined || !state.unchecked) return;
        requests.index(sessionId, log);
        const placed = requests.of(sessionId);
        const queue = state.queue.filter((item) => !placed.has(item.prompt.requestId));
        state.unchecked = false;
        if (queue.length === state.queue.length) return;
        yield* setQueue(state, queue);
        // Placed, as the log says: a journal that still has them is checked against it again on the next start.
        yield* persistOrWarn(sessionId);
        yield* queueChanged(sessionId);
      });

    /**
     * What reading or changing a session's queue needs first: a restored one's checked against its log (`reconcile`),
     * reading the log if that was not done yet. Fails as the reading does, as the queue cannot be told without it; a
     * session found gone takes its state with it.
     */
    const checked = (sessionId: string): Effect.Effect<void, AgentError> =>
      Effect.suspend(() =>
        queues.get(sessionId)?.unchecked !== true
          ? Effect.void
          : sessions.events(sessionId).pipe(
              Effect.mapError(failedAs(sessionId, "Session")),
              Effect.flatMap((log) => admit.withPermits(1)(reconcile(sessionId, log))),
              Effect.catchIf(gone, () => removed(sessionId)),
            ),
      );

    /**
     * Reads what taking up a restored session needs, once: its log, checking its queue against it (`reconcile`) at
     * once, as that needs nothing more; then its info and, for its suspended turn, how that resumes and the model it
     * continues on. Outside `admit`, as it waits on the store, the session held (`ready`). It changes nothing else,
     * so a failure leaves the session as it was, its queue checked if the log was read, to be taken up later.
     */
    const prepare = (sessionId: string, suspended: Suspended | undefined): Effect.Effect<Prepared, AgentError> =>
      Effect.gen(function* () {
        const log = yield* sessions.events(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        yield* admit.withPermits(1)(reconcile(sessionId, log));
        const info = yield* sessions.get(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        // A damaged log takes no writes: its turn cannot close, nor its queue run, until it is forked.
        if (info.damaged !== undefined) {
          return yield* new AgentError({
            sessionId,
            reason: "Session",
            message: `Session ${sessionId} is damaged at line ${info.damaged.line} (${info.damaged.reason}), so it takes no turns; fork it to go on`,
          });
        }
        if (suspended === undefined) return { info };
        const resume = planResume(log, suspended.turnId, suspended.marked);
        if (resume.kind === "ended") return { info, turn: { suspended, resumption: resume } };
        // Being cancelled, or closed as it ended, it only closes, so no model need resolve.
        if (suspended.cancelling || suspended.closing !== undefined) return { info, turn: { suspended, resumption: { ...resume, model: undefined } } };
        const resumption: Resumption =
          resume.kind === "not-started"
            ? { kind: "not-started", model: yield* resolveModel(sessionId, suspended.prompts.at(-1)?.prompt.options) }
            : {
                kind: "open",
                plan: resume.plan,
                // The model it ran on, if it still exists; else the default, as a new turn would get.
                model:
                  resume.plan.model === undefined
                    ? yield* resolveModel(sessionId)
                    : yield* llm.model(resume.plan.model).pipe(Effect.catch(() => resolveModel(sessionId))),
              };
        return { info, turn: { suspended, resumption } };
      });

    /**
     * Holds the session until the scope closes, before admission, so a wait for its deletion to end holds up no
     * other session and can be interrupted, and the hold a turn takes under `admit` does not wait (see `holdFor`); and
     * reads it if it is restored (`prepare`). A session found gone takes its state with it.
     */
    const ready = (sessionId: string): Effect.Effect<Prepared | undefined, AgentError, Scope.Scope> =>
      Effect.gen(function* () {
        yield* sessions.hold(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
        const state = queues.get(sessionId);
        return state?.restored === true ? yield* prepare(sessionId, state.suspended) : undefined;
      }).pipe(Effect.tapError((error) => (gone(error) ? removed(sessionId) : Effect.void)));

    /**
     * Takes a restored session up as `prepared` read it (under `admit`, the session held already, its queue checked):
     * its suspended turn resumes, or else its queue runs on, unless held. Nothing changes before the turn's hold is
     * taken, which can fail.
     */
    const reopen = (sessionId: string, prepared: Prepared) =>
      Effect.gen(function* () {
        const state = queues.get(sessionId);
        // Taken up meanwhile, or gone.
        if (state === undefined || !state.restored || state.unchecked || state.suspended !== prepared.turn?.suspended) return;
        const { turn } = prepared;
        const next = turn === undefined && !state.held ? state.queue[0] : undefined;
        const lease = turn !== undefined || next !== undefined ? yield* holdFor(sessionId) : undefined;
        const takenUp = (taken: SessionState<Running>) =>
          Effect.sync(() => {
            taken.restored = false;
            taken.suspended = undefined;
          });
        if (lease !== undefined && turn !== undefined) {
          const { suspended, resumption } = turn;
          yield* start(sessionId, suspended.turnId, suspended.prompts, lease, {
            resume: { info: prepared.info, resumption },
            cancelling: suspended.cancelling,
            marked: suspended.marked,
            ...(suspended.closing === undefined ? {} : { closing: suspended.closing }),
            taking: takenUp,
          });
        } else if (lease !== undefined && next !== undefined) {
          // Not recorded, so not started: the session stays to be taken up later.
          yield* start(sessionId, newId(), [next], lease, { taking: (taken) => Effect.andThen(takenUp(taken), setQueue(taken, taken.queue.slice(1))) });
          yield* queueChanged(sessionId);
        } else yield* takenUp(state);
      });

    /** A restored session `resume` could not take up stays as it was, to be taken up when next prompted, or at the next start. */
    const notTakenUp = (sessionId: string) => (error: AgentError) =>
      gone(error)
        ? Effect.void
        : Effect.logWarning(`agent: could not take up session ${sessionId}: ${error.message}; it is taken up when next prompted, or at the next start`);

    /** Takes a restored session up now (`ready`, then `reopen`); fails as `ready` does, the session left as it was. */
    const resume = (sessionId: string): Effect.Effect<void, AgentError> =>
      Effect.scoped(
        Effect.flatMap(ready(sessionId), (prepared) =>
          prepared === undefined ? Effect.void : admit.withPermits(1)(Effect.uninterruptible(reopen(sessionId, prepared))),
        ),
      );

    const view = (sessionId: string): Effect.Effect<AgentView, AgentError> =>
      Effect.andThen(
        checked(sessionId),
        Effect.sync(() => {
          // A session never prompted here gets no state: a view keeps nothing. A suspended turn is not running: no view.
          const state = queues.get(sessionId) ?? { turn: undefined, queue: [], revision: base };
          const queue = { queue: state.queue.map((item) => item.prompt), queueRevision: state.revision };
          return state.turn === undefined ? { output: [], ...queue } : { ...state.turn.live.view(), ...queue };
        }),
      );

    // Running tools' output, kept for `view` and for a turn resumed after a crash. Backpressure rather than loss:
    // keeping it is cheap, and a dropped chunk would leave a hole.
    yield* owner.observe(
      ToolOutput,
      ({ sessionId, toolCallId, chunk, offset }) =>
        Effect.sync(() => {
          queues.get(sessionId)?.turn?.live.toolOutput(toolCallId, chunk, offset);
        }),
      { buffer: 1024, overflow: "suspend" },
    );
    // Every deletion heard, so no queued prompt's caller waits on a session that is gone: one that finds no room waits
    // for it. Never for good: the store announces a deletion once no hold waits on it, and `removed` takes no lock
    // that a call into the store is made under (not `admit`). One deleted while no instance listened (between two,
    // say) is found gone when the next starts.
    yield* owner.observe(SessionRemoved, ({ sessionId }) => removed(sessionId), { overflow: "suspend" });
    /**
     * The model and thinking the session's last turn ran with, for a turn a notice starts: a notice chooses none, and
     * the agent's default may be another model, whose turn would also declare the prompt afresh.
     */
    const lastTurnOptions = (sessionId: string): Effect.Effect<TurnOptions> =>
      sessions.branch(sessionId).pipe(
        Effect.map((branch): TurnOptions => {
          for (let i = branch.length - 1; i >= 0; i--) {
            const data = branch[i]!.data;
            if (data.type !== "turn-start") continue;
            return { ...(data.model === undefined ? {} : { model: data.model }), ...(data.thinking === undefined ? {} : { thinking: data.thinking }) };
          }
          return {};
        }),
        Effect.catch(() => Effect.succeed({})),
      );
    // A plugin's notice for the model, placed as its `context`: steering the running turn, or starting one after a turn
    // that ran to its end (else waiting for the user's next prompt; see `PromptOptions.source`). Forked with the turns,
    // so the observer does not wait for the turn, and the agent closing stops the wait.
    yield* owner.observe(
      ModelNotice,
      ({ sessionId, id, source, content, display }) =>
        Effect.asVoid(
          Effect.forkIn(
            Effect.flatMap(lastTurnOptions(sessionId), (options) =>
              prompt(sessionId, content, {
                ...options,
                whenBusy: "steer",
                requestId: `${source}:${id}`,
                source,
                ...(display === undefined ? {} : { display }),
              }),
            ).pipe(Effect.catch((error) => Effect.logWarning(`agent: ${source}'s notice for session ${sessionId} was not placed: ${error.message}`))),
            turns,
          ),
        ),
      { overflow: "suspend" },
    );

    // What the last instance left: each session's journal becomes its state, as it was, its turn suspended.
    const journals = yield* readJournals(files);
    queues.restore(journals);
    // Each taken up now if it can be; one that cannot is when its session is next prompted, or at the next start. One
    // with nothing to take up is held all the same, which finds a session deleted while no agent ran, and removes it.
    for (const sessionId of journals.keys()) yield* resume(sessionId).pipe(Effect.catch(notTakenUp(sessionId)));

    // What the devtools and `lemma inspectors` show of it. Only a view: failing to add it never stops the agent.
    yield* owner
      .add(Inspectors, {
        id: "agent.turns",
        title: "Running turns",
        description: "Each session with a turn running now, how long it has run, or one suspended until it resumes, and what is queued",
        snapshot: Effect.map(Clock.currentTimeMillis, (now) =>
          [...queues.all()].flatMap(([sessionId, state]) =>
            state.turn === undefined && state.suspended === undefined && state.queue.length === 0
              ? []
              : [
                  {
                    session: sessionId,
                    turn: (state.turn ?? state.suspended)?.turnId ?? "",
                    started: state.turn === undefined ? "" : new Date(state.turn.startedAt).toISOString(),
                    runningMs: state.turn === undefined ? 0 : now - state.turn.startedAt,
                    suspended: state.suspended !== undefined,
                    cancelling: (state.turn ?? state.suspended)?.cancelling ?? false,
                    queued: state.queue.length,
                    // Restored, and not yet checked against the log: some may have been placed.
                    unchecked: state.unchecked,
                  },
                ],
          ),
        ),
      })
      .pipe(Effect.ignore);

    // What stopping the host would cut off: a turn it cut off resumes when the agent starts again, and queued prompts
    // run then, but nothing runs meanwhile. Only a view: failing to add it never stops the agent.
    yield* owner
      .add(InProgress, {
        id: "agent.turns",
        title: "Turns",
        items: Effect.sync(() =>
          [...queues.all()].flatMap(([sessionId, state]) => [
            ...(state.turn === undefined ? [] : [`a turn running in session ${sessionId}`]),
            ...(state.queue.length === 0 ? [] : [`${state.queue.length} prompt${state.queue.length === 1 ? "" : "s"} queued in session ${sessionId}`]),
          ]),
        ),
      })
      .pipe(Effect.ignore);

    const agent: Context.Service.Shape<typeof Agent> = {
      prompt,
      cancel,
      busy: (sessionId: string) => Effect.sync(() => queues.get(sessionId)?.turn !== undefined),
      running: Effect.sync(() => [...queues.all()].flatMap(([sessionId, state]) => (state.turn === undefined ? [] : [sessionId]))),
      queue: (sessionId: string) =>
        Effect.andThen(
          checked(sessionId),
          Effect.sync(() => (queues.get(sessionId)?.queue ?? []).map((item) => item.prompt)),
        ),
      withdraw,
      promote,
      view,
    };
    // How clients reach it: the transport serves what `Channels` holds.
    for (const channel of serveAgent(agent, events)) yield* owner.add(Channels, channel);
    return agent;
  });
