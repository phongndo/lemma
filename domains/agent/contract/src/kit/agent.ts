import * as os from "node:os";
import { Clock, Deferred, Duration, Effect, Schedule, Schema, Scope, Semaphore } from "effect";
import type { Context } from "effect";
import { assert, Events, Hooks, Registries } from "@lemma/core";
import type { PluginSetup } from "@lemma/core";
import { Channels, Inspectors, randomId, secureIds } from "@lemma/contracts";
import type { HostControl, IdSource, Paths } from "@lemma/contracts";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { InProgress } from "@lemma/cli";
import type { Llm } from "@lemma/llm";
import { SessionRemoved } from "@lemma/sessions";
import type { Sessions } from "@lemma/sessions";
import { ToolOutput } from "@lemma/tools";
import type { ToolRunner } from "@lemma/tools";
import { Agent, ModelNotice, PromptSections, serveAgent } from "../agent.ts";
import { makeInputDecisions } from "./input.ts";
import { makeQueues, REVISIONS_PER_INSTANCE } from "./queue.ts";
import type { SessionState } from "./queue.ts";
import { baseSection, environmentSection } from "./prompt.ts";
import { makeRequestIndex } from "./requests.ts";
import { makeSlots } from "./slots.ts";
import { nextInstance, readJournals } from "./state.ts";
import type { StateFiles } from "./state.ts";
import { makeKeptBranches } from "./agent/branches.ts";
import { cancel, lastTurnOptions, promote, prompt, queue, view, withdraw } from "./agent/calls.ts";
import { ID_BYTES } from "./agent/context.ts";
import type { AgentContext, Running } from "./agent/context.ts";
import { makeSections } from "./agent/sections.ts";
import { notTakenUp, removed, resume } from "./agent/takeup.ts";

/*
 * The agent as `agent.loop` runs it (`makeAgent`), and its settings. Its parts are in `agent/`: what they share
 * (`context.ts`), a session's turn from start to end (`turns.ts`), restored sessions taken up (`takeup.ts`), callers'
 * calls (`calls.ts`), the prompt's sections (`sections.ts`), and the branches kept for the next turn (`branches.ts`).
 */

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

/**
 * How long a kept branch stays unused, at most (it goes after half of that at least): a store lets an idle session's
 * events go (`sessions.files` after five minutes, by default), and a branch kept longer would hold them alone, and
 * beside the copy the store reads back when the session is next used.
 */
const BRANCH_IDLE_MS = 5 * 60_000;

/** What the devtools and `lemma inspectors` show of the agent: each session with a turn, running or suspended, or a queue. */
const turnRows = (states: Iterable<[string, SessionState<Running>]>, now: number) =>
  [...states].flatMap(([sessionId, state]) =>
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
  );

/** What stopping the host would cut off: a turn it cut off resumes when the agent starts again, and queued prompts run then, but nothing runs meanwhile. */
const inProgress = (states: Iterable<[string, SessionState<Running>]>) =>
  [...states].flatMap(([sessionId, state]) => [
    ...(state.turn === undefined ? [] : [`a turn running in session ${sessionId}`]),
    ...(state.queue.length === 0 ? [] : [`${state.queue.length} prompt${state.queue.length === 1 ? "" : "s"} queued in session ${sessionId}`]),
  ]);

/** What the agent hears: running tools' output, sessions deleted, and plugins' notices for the model. */
const listen = (agent: AgentContext, owner: PluginSetup<AgentConfig>) =>
  Effect.gen(function* () {
    // Running tools' output, kept for `view` and for a turn resumed after a crash. Backpressure rather than loss:
    // keeping it is cheap, and a dropped chunk would leave a hole.
    yield* owner.observe(
      ToolOutput,
      ({ sessionId, toolCallId, chunk, offset }) =>
        Effect.sync(() => {
          agent.queues.get(sessionId)?.turn?.live.toolOutput(toolCallId, chunk, offset);
        }),
      { buffer: 1024, overflow: "suspend" },
    );
    // Every deletion heard, so no queued prompt's caller waits on a session that is gone: one that finds no room waits
    // for it. Never for good: the store announces a deletion once no hold waits on it, and `removed` takes no lock
    // that a call into the store is made under (not `admit`). One deleted while no instance listened (between two,
    // say) is found gone when the next starts.
    yield* owner.observe(SessionRemoved, ({ sessionId }) => removed(agent, sessionId), { overflow: "suspend" });
    // A plugin's notice for the model, placed as its `context`: steering the running turn, or starting one after a turn
    // that ran to its end (else waiting for the user's next prompt; see `PromptOptions.source`), on the model and
    // thinking the session's last turn had. Forked with the turns, so the observer does not wait for the turn, and the
    // agent closing stops the wait.
    yield* owner.observe(
      ModelNotice,
      ({ sessionId, id, source, content, display }) =>
        Effect.asVoid(
          Effect.forkIn(
            Effect.flatMap(lastTurnOptions(agent, sessionId), (turnOptions) =>
              prompt(agent, sessionId, content, {
                ...turnOptions,
                whenBusy: "steer",
                requestId: `${source}:${id}`,
                source,
                ...(display === undefined ? {} : { display }),
              }),
            ).pipe(Effect.catch((error) => Effect.logWarning(`agent: ${source}'s notice for session ${sessionId} was not placed: ${error.message}`))),
            agent.turns,
          ),
        ),
      { overflow: "suspend" },
    );
  });

/** What the agent shows of itself. */
const report = (agent: AgentContext, owner: PluginSetup<AgentConfig>) =>
  Effect.gen(function* () {
    // What the devtools and `lemma inspectors` show of it, and what stopping the host would cut off. Only views:
    // failing to add one never stops the agent.
    yield* owner
      .add(Inspectors, {
        id: "agent.turns",
        title: "Running turns",
        description: "Each session with a turn running now, how long it has run, or one suspended until it resumes, and what is queued",
        snapshot: Effect.map(Clock.currentTimeMillis, (now) => turnRows(agent.queues.all(), now)),
      })
      .pipe(Effect.ignore);
    yield* owner.add(InProgress, { id: "agent.turns", title: "Turns", items: Effect.sync(() => inProgress(agent.queues.all())) }).pipe(Effect.ignore);
  });

/**
 * The agent, as `agent.loop` runs it: the turn loop, its queue and journal, resuming after a restart, its live view,
 * and its channels, inspector, and in-progress report, registered through `owner` (the plugin running it, whose
 * config is `AgentConfig`), on what `options` gives it, and on this process and its file system for what they leave
 * out. Returns the `Agent` service the plugin provides. A loop of another kind builds on the same durability, and
 * shapes its turns with the agent's hooks (`AgentRequestHook`, `AgentContinueHook`).
 */
export const makeAgent = (deps: AgentDeps, owner: PluginSetup<AgentConfig>, options: AgentOptions = {}) =>
  Effect.gen(function* () {
    const { sessions, llm, tools, host, paths } = deps;
    const config = owner.config;
    const files: StateFiles = { home: paths.home, fs: options.fs ?? nodeFileSystem };
    const ids = options.ids ?? secureIds;
    const newId = () => randomId(ids, ID_BYTES);
    const instance = yield* nextInstance(files);
    assert(instance * REVISIONS_PER_INSTANCE < Number.MAX_SAFE_INTEGER, `agent instance ${instance} has no room for its revisions`);
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
    const hooks = yield* Hooks;
    const events = yield* Events;
    const base = instance * REVISIONS_PER_INSTANCE;
    const agent: AgentContext = {
      sessions,
      llm,
      host,
      events,
      defaultModel: config.defaultModel,
      files,
      base,
      newId,
      services: { sessions, llm, tools, host, hooks, events, sections: makeSections(registries), trace: owner.trace, newId },
      settings: {
        maxSteps: config.maxSteps,
        retries: config.retries,
        retryDelay: config.retryDelay * 1000,
        maxRetryDelay: config.maxRetryDelay * 1000,
        parallelTools: config.parallelTools,
        keepCancelled: config.keepCancelled,
      },
      // Turns belong to the plugin, not the caller: they outlive an interrupted `prompt`. They run in their own scope,
      // and closing the plugin first marks them suspended, so they stay open in the log and resume in the next instance.
      turns: yield* Scope.fork(yield* Effect.scope, "parallel"),
      stopping: yield* Deferred.make<void>(),
      suspending: false,
      queues: makeQueues<Running>(files, base),
      admit: yield* Semaphore.make(1),
      slots: makeSlots(config.maxRunning),
      requests: makeRequestIndex(sessions),
      branches: makeKeptBranches(),
      decisions: makeInputDecisions(hooks),
    };
    const { queues } = agent;
    // Stopping lets each turn reach its next step or tool call, for `stopGrace`, and suspend itself there; whatever
    // still runs after it is interrupted when the turns' scope closes, as a crash would cut it off.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        agent.suspending = true;
        yield* Deferred.succeed(agent.stopping, undefined);
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
    // A branch kept before the last sweep, and not taken since, goes: one unused for between half of `BRANCH_IDLE_MS` and all of it.
    yield* owner.background("forget idle branches", Effect.repeat(Effect.sync(agent.branches.sweep), Schedule.spaced(Duration.millis(BRANCH_IDLE_MS / 2))));

    yield* listen(agent, owner);

    // What the last instance left: each session's journal becomes its state, as it was, its turn suspended.
    const journals = yield* readJournals(files);
    queues.restore(journals);
    // Each taken up now if it can be; one that cannot is when its session is next prompted, or at the next start. One
    // with nothing to take up is held all the same, which finds a session deleted while no agent ran, and removes it.
    for (const sessionId of journals.keys()) yield* resume(agent, sessionId).pipe(Effect.catch(notTakenUp(sessionId)));

    yield* report(agent, owner);

    const service: Context.Service.Shape<typeof Agent> = {
      prompt: (sessionId, content, promptOptions) => prompt(agent, sessionId, content, promptOptions),
      cancel: (sessionId) => cancel(agent, sessionId),
      busy: (sessionId: string) => Effect.sync(() => queues.get(sessionId)?.turn !== undefined),
      running: Effect.sync(() => [...queues.all()].flatMap(([sessionId, state]) => (state.turn === undefined ? [] : [sessionId]))),
      queue: (sessionId) => queue(agent, sessionId),
      withdraw: (sessionId, requestId) => withdraw(agent, sessionId, requestId),
      promote: (sessionId, requestId) => promote(agent, sessionId, requestId),
      view: (sessionId) => view(agent, sessionId),
    };
    // How clients reach it: the transport serves what `Channels` holds.
    for (const channel of serveAgent(service, events)) yield* owner.add(Channels, channel);
    return service;
  });
