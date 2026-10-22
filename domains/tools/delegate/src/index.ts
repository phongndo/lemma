import * as path from "node:path";
import { Deferred, Effect, Exit, Result, Schedule, Schema } from "effect";
import { definePlugin, Events, Registries } from "@lemma/core";
import { callHere } from "@lemma/cli";
import { Channels, Interaction, Paths, serveChannel } from "@lemma/contracts";
import { AgentChannels, AgentRequestHook, ModelNotice, PromptSections } from "@lemma/agent";
import { SessionAppended, SessionChannels, SessionRemoved } from "@lemma/sessions";
import { Tools } from "@lemma/tools";
import { DelegateChannels } from "./channels.ts";
import { DELEGATE, delegateTool, depthSlots, discard, failure, isCode, modesSection, outcomeOf, place, sessionGone, stopTurn } from "./delegate.ts";
import type { Settled } from "./delegate.ts";
import { jobFiles, workingSection } from "./jobs.ts";
import type { Job } from "./jobs.ts";
import { bounded, depthOf, SOURCE } from "./lineage.ts";

export { DelegateChannels } from "./channels.ts";
export { DELEGATE, DelegateInput, DelegateOutput, Ended } from "./delegate.ts";
export type { DelegateDetails } from "./delegate.ts";
export { depthOf, firstLine, forkPoint, lastTurnOptions, requestIdOf, summarize } from "./lineage.ts";

const count = (fallback: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefaultType(Effect.sync(() => fallback)));

export const Config = Schema.Struct({
  maxDelegations: count(4).annotate({
    title: "Agents at once",
    description: "How many agents work at once at each depth, across every thread; more wait for one to finish.",
  }),
  maxDepth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 1)))
    .annotate({
      title: "Delegation depth",
      description: "How deep delegations go: an agent this many levels down hands no task on. 0 turns delegation off.",
    }),
  confirm: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))).annotate({
    title: "Ask before starting an agent",
    description: "Ask you before each new agent starts.",
  }),
  maxOutputChars: count(20_000).annotate({
    title: "Answer kept (characters)",
    description: "Text characters of an agent's answer the model reads; the rest stays in the agent's thread.",
  }),
});

/** The section naming the modes offered to agents and the thread's agents at work. */
const SECTION = "tools.delegate.agents";

/** How often a notice no thread has logged yet is published again: one published while no agent heard it is lost. */
const RETELL = "15 seconds";

/** How a background agent ended that its thread was deleted under, before how it ended could be read. */
const GONE: Settled = { ended: "error", answer: "", error: "Its thread was deleted before it finished." };
/** How a background agent ended that was stopped before its prompt was placed: dropped, or its prompt withdrawn. */
const STOPPED: Settled = { ended: "cancelled", answer: "", error: "It was stopped before it started." };

/** What a finished agent tells the thread that started it, and the line a transcript shows for it. */
const noticeOf = (job: Job, settled: Settled, budget: number) => {
  const done = settled.ended === "done" || settled.ended === "handled";
  const display = done ? `${job.title} finished` : settled.ended === "cancelled" ? `${job.title} was stopped` : `${job.title} failed`;
  const body = [settled.error === undefined ? "" : `Error: ${settled.error}`, bounded(settled.answer, budget, job.child)]
    .filter((part) => part !== "")
    .join("\n\n");
  const text = `<agent_result title="${job.title.replaceAll('"', "'")}" session="${job.child}" ended="${settled.ended}">\n${body}\n</agent_result>`;
  return { text, display };
};

/**
 * `delegate`: a task handed to an agent, a thread of its own working for this one, waited on or left to work in the
 * background (`delegate.ts`). Background agents are this plugin's work: each is kept as a file until the thread it
 * reports to has heard how it finished (a `ModelNotice`), so a reload or a restart waits on it again and tells the
 * thread all the same. A prompt section lists the modes offered to agents and the thread's agents still at work.
 */
export default definePlugin({
  id: "tools.delegate",
  uses: ["lemma/agent@2", "lemma/sessions@1", "lemma/tools@1"],
  version: "0.1.0",
  config: Config,
  requires: { interaction: Interaction, paths: Paths },
  setup: function* ({ interaction, paths }, owner) {
    const config = owner.config;
    if (config.maxDepth === 0) return;
    const registries = yield* Registries;
    const events = yield* Events;
    const files = jobFiles(path.join(paths.home, "delegate", "agents"));
    const slotsAt = depthSlots(config.maxDelegations);
    /** The background agents this instance waits on, and those whose notice it owes, by thread and notice. */
    const working = new Map<string, Job>();
    const owed = new Map<string, Job>();
    /** The background agents waiting for a slot, by agent: what drops one before its prompt is placed (`delegate.stop`). */
    const queued = new Map<string, Deferred.Deferred<void>>();
    /** The waited-on agents whose prompts are being placed, by agent: their request ids, which Stop withdraws. */
    const placing = new Map<string, string>();
    const key = (job: Pick<Job, "parent" | "noticeId">) => `${job.parent}\0${job.noticeId}`;
    const requestId = (job: Pick<Job, "noticeId">) => `${SOURCE}:${job.noticeId}`;

    const forget = (job: Job) =>
      Effect.promise(async () => {
        working.delete(key(job));
        owed.delete(key(job));
        await files.remove(job);
      });

    /** Whether the thread has the notice already: a restart after it was placed and before its file went. */
    const told = (job: Job) =>
      callHere(registries, SessionChannels.events, { sessionId: job.parent }).pipe(
        Effect.map((log) => log.some((event) => event.data.type === "context" && event.data.requestId === requestId(job))),
      );

    /**
     * Places a background agent's prompt once it has a slot (a follow-up takes none, so `dropped` is none), unless it is
     * dropped first: whichever takes it out of `queued` first decides, its slot or `delegate.drop`, so a prompt once
     * placed is never dropped.
     */
    const slotted = (job: Job, dropped: Deferred.Deferred<void> | undefined) =>
      dropped === undefined
        ? place(registries, job, false)
        : Effect.raceFirst(
            slotsAt(job.depth).withPermits(1)(Effect.suspend(() => (queued.delete(job.child) ? place(registries, job, false) : Effect.never))),
            Effect.as(Deferred.await(dropped), "dropped" as const),
          ).pipe(Effect.ensuring(Effect.sync(() => queued.get(job.child) === dropped && queued.delete(job.child))));

    /**
     * Waits on a background agent's turn, placing its prompt if it never was, and tells its thread how it ended. A
     * reload interrupts only the waiting: the agent works on, and the next instance waits on it from its file.
     */
    const wait = (job: Job, dropped: Deferred.Deferred<void> | undefined) =>
      Effect.gen(function* () {
        const placed = yield* Effect.result(slotted(job, dropped));
        const stopped = Result.isFailure(placed) ? isCode("Retracted")(placed.failure) : placed.success === "dropped";
        const settled = yield* Effect.suspend((): Effect.Effect<Settled, unknown> => {
          if (stopped) return Effect.succeed(STOPPED);
          if (Result.isFailure(placed))
            return Effect.succeed(
              sessionGone(placed.failure) ? GONE : { ended: "error", answer: "", error: `It could not start: ${failure("agent.prompt", placed.failure)}` },
            );
          if (placed.success === "dropped") return Effect.succeed(STOPPED);
          // Its thread deleted as its turn ended, it still ends, and its thread is told. Any other failure to read how it
          // ended keeps its file, so a restart waits on it again.
          return outcomeOf(registries, job.child, job.requestId, placed.success).pipe(
            Effect.catch((error) => (sessionGone(error) ? Effect.succeed(GONE) : Effect.fail(error))),
          );
        });
        // Refused or stopped before its prompt was placed, an agent its call made that holds nothing goes, as a
        // waited-on one does; one that holds work (a turn ran, or a person wrote to it) stays.
        if (stopped || (Result.isFailure(placed) && !sessionGone(placed.failure))) yield* discard(registries, job.child, job.emptyAt);
        const parent = yield* Effect.exit(told(job));
        // The thread it reports to is gone, or has heard already: nothing is owed.
        if (Exit.isFailure(parent) || parent.value) return yield* forget(job);
        working.delete(key(job));
        owed.set(key(job), job);
        const { text, display } = noticeOf(job, settled, config.maxOutputChars);
        const owing = () => owed.has(key(job));
        // Told again until the thread logs it (`SessionAppended`, below): one no agent heard, as while one reloads, is
        // not lost, and the agent places one id once.
        yield* Effect.suspend(() =>
          owing()
            ? events.publish(ModelNotice, { sessionId: job.parent, id: job.noticeId, source: SOURCE, content: [{ type: "text", text }], display })
            : Effect.void,
        ).pipe(Effect.repeat({ schedule: Schedule.spaced(RETELL), while: owing }));
      });

    /** Whether the agent's log has its prompt: placed before a restart, its turn runs on its own. */
    const placedBefore = (job: Job) =>
      Effect.map(Effect.exit(callHere(registries, SessionChannels.events, { sessionId: job.child })), (log) =>
        Exit.isSuccess(log) ? log.value.some((event) => event.data.type === "message" && event.data.requestId === job.requestId) : false,
      );

    const droppable = (job: Job) => Effect.tap(Deferred.make<void>(), (dropped) => Effect.sync(() => queued.set(job.child, dropped)));

    const start = (job: Job, reloaded = false) =>
      Effect.gen(function* () {
        if (working.has(key(job)) || owed.has(key(job))) return;
        working.set(key(job), job);
        // Droppable from the moment the call names it, until its slot comes.
        const fresh = reloaded || job.followUp === true ? undefined : yield* droppable(job);
        yield* owner.background(
          `agent ${job.child}`,
          Effect.gen(function* () {
            // One a restart left is droppable only if its prompt was never placed: a placed one's turn runs on its own,
            // taking no slot, and Stop withdraws or cancels it instead.
            const dropped = fresh ?? (reloaded && job.followUp !== true && !(yield* placedBefore(job)) ? yield* droppable(job) : undefined);
            yield* wait(job, dropped);
          }).pipe(Effect.catch((error) => Effect.logWarning(`tools.delegate: waiting on agent ${job.child}: ${String(error)}`))),
        );
      }).pipe(Effect.catch(() => Effect.void));

    yield* owner.add(
      Tools,
      delegateTool({
        registries,
        interaction,
        maxDelegations: config.maxDelegations,
        maxDepth: config.maxDepth,
        confirm: config.confirm,
        budget: config.maxOutputChars,
        slotsAt,
        placing,
        background: {
          start: (job) =>
            Effect.andThen(
              Effect.promise(() => files.save(job)),
              start(job),
            ),
        },
      }),
    );

    yield* owner.add(
      Channels,
      serveChannel(DelegateChannels.stop, ({ sessionId }) =>
        Effect.gen(function* () {
          // Taken out of the queue and told in one step, so an interruption cannot leave it neither dropped nor placed.
          const dropped = yield* Effect.uninterruptible(
            Effect.suspend(() => {
              const waiting = queued.get(sessionId);
              if (waiting === undefined) return Effect.succeed(false);
              queued.delete(sessionId);
              return Effect.as(Deferred.succeed(waiting, undefined), true);
            }),
          );
          if (dropped) return "dropped" as const;
          const requestId = [...working.values()].find((job) => job.child === sessionId)?.requestId ?? placing.get(sessionId);
          if (requestId !== undefined) return (yield* stopTurn(registries, sessionId, requestId)) ? ("withdrawn" as const) : ("cancelled" as const);
          yield* callHere(registries, AgentChannels.cancel, { sessionId });
          return "cancelled" as const;
        }),
      ),
    );

    // The notice placed: the thread has heard, and the agent's file goes.
    yield* owner.observe(SessionAppended, ({ sessionId, event }) =>
      Effect.suspend(() => {
        if (event.data.type !== "context" || event.data.requestId?.startsWith(`${SOURCE}:`) !== true) return Effect.void;
        const job = owed.get(key({ parent: sessionId, noticeId: event.data.requestId.slice(SOURCE.length + 1) }));
        return job === undefined ? Effect.void : forget(job);
      }),
    );
    // A thread deleted is owed nothing; its agents work on, threads of their own.
    yield* owner.observe(SessionRemoved, ({ sessionId }) =>
      Effect.forEach(
        [...working.values(), ...owed.values()].filter((job) => job.parent === sessionId),
        forget,
        { discard: true },
      ),
    );

    const offers = (tools: readonly { readonly spec: { readonly name: string } }[]) => tools.some((tool) => tool.spec.name === DELEGATE);
    yield* owner.add(PromptSections, {
      id: SECTION,
      text: ({ sessionId, cwd, tools }) =>
        offers(tools)
          ? Effect.map(modesSection(registries, cwd), (modes) => {
              const parts = [modes, workingSection([...working.values()].filter((job) => job.parent === sessionId))].filter((part) => part !== undefined);
              return parts.length === 0 ? undefined : `<agents>\n${parts.join("\n\n")}\n</agents>`;
            })
          : undefined,
    });
    // An agent as deep as delegations go is not offered the tool, which would only refuse it. The section is written for
    // the tools on offer before the request's are chosen: once they are, it goes with the tool, so a mode without it (an
    // explorer) is told nothing of agents.
    yield* owner.on(
      AgentRequestHook,
      (draft, next) => {
        const deepest = depthOf(draft.branch) + 1 > config.maxDepth;
        const offered = deepest ? { ...draft, tools: draft.tools.filter((tool) => tool.spec.name !== DELEGATE) } : draft;
        return Effect.map(next(offered), (plan) =>
          offers(plan.tools) ? plan : { ...plan, sections: plan.sections.filter((section) => section.id !== SECTION) },
        );
      },
      { phase: "select" },
    );

    // What a reload or a restart left: each background agent waited on again, its thread told when it finishes.
    for (const job of yield* Effect.promise(() => files.all())) yield* start(job, true);
  },
});
