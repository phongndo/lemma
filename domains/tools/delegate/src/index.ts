import * as path from "node:path";
import { Effect, Exit, Result, Schedule, Schema } from "effect";
import { definePlugin, Events, Registries } from "@lemma/core";
import { Interaction, Paths } from "@lemma/contracts";
import { AgentRequestHook, ModelNotice, PromptSections } from "@lemma/agent";
import { SessionAppended, SessionChannels, SessionRemoved } from "@lemma/sessions";
import { Tools } from "@lemma/tools";
import { callValue, DELEGATE, delegateTool, depthSlots, discard, failure, isCode, modesSection, outcomeOf, place } from "./delegate.ts";
import { jobFiles, workingSection } from "./jobs.ts";
import type { Job } from "./jobs.ts";
import { bounded, SOURCE } from "./lineage.ts";

export { DELEGATE, DelegateInput, DelegateOutput, Ended } from "./delegate.ts";
export type { DelegateDetails } from "./delegate.ts";
export { depthOf, firstLine, forkPoint, lastTurnOptions, requestIdOf, summarize } from "./lineage.ts";

const count = (fallback: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefaultType(Effect.sync(() => fallback)));

export const Config = Schema.Struct({
  maxDelegations: count(4).annotate({
    title: "Agents at once",
    description: "How many agents work at once at each depth; more wait for one to finish.",
  }),
  maxDepth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 2)))
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

/** What a finished agent tells the thread that started it, and the line a transcript shows for it. */
const noticeOf = (job: Job, settled: { readonly ended: string; readonly answer: string; readonly error?: string }, budget: number) => {
  const done = settled.ended === "done" || settled.ended === "handled";
  const display = done
    ? `${job.title} finished`
    : settled.ended === "cancelled" || settled.ended === "timeout"
      ? `${job.title} was stopped`
      : `${job.title} failed`;
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
      callValue(registries, SessionChannels.events, { sessionId: job.parent }).pipe(
        Effect.map((log) => log.some((event) => event.data.type === "context" && event.data.requestId === requestId(job))),
      );

    /**
     * Waits on a background agent's turn, placing its prompt if it never was, and tells its thread how it ended. A
     * reload interrupts only the waiting: the agent works on, and the next instance waits on it from its file.
     */
    const wait = (job: Job) =>
      Effect.gen(function* () {
        const deadline = job.timeoutMs === undefined ? undefined : job.startedAt + job.timeoutMs;
        const placing = place(registries, job, deadline, false);
        const placed = yield* Effect.result(job.followUp === true ? placing : slotsAt(job.depth).withPermits(1)(placing));
        const settled: { readonly ended: string; readonly answer: string; readonly error?: string } = Result.isSuccess(placed)
          ? yield* outcomeOf(registries, job.child, job.requestId, placed.success, job.timeoutMs)
          : isCode("NotFound")(placed.failure)
            ? { ended: "error", answer: "", error: "Its thread was deleted before it finished." }
            : { ended: "error", answer: "", error: `It could not start: ${failure("agent.prompt", placed.failure)}` };
        // Refused before its prompt was placed, an agent its call made that holds nothing goes, as a waited-on one does;
        // one that holds work (a turn ran, or a person wrote to it) stays.
        if (Result.isFailure(placed) && !isCode("NotFound")(placed.failure)) yield* discard(registries, job.child, job.emptyAt);
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

    const start = (job: Job) =>
      Effect.gen(function* () {
        if (working.has(key(job)) || owed.has(key(job))) return;
        working.set(key(job), job);
        yield* owner.background(
          `agent ${job.child}`,
          wait(job).pipe(Effect.catch((error) => Effect.logWarning(`tools.delegate: waiting on agent ${job.child}: ${String(error)}`))),
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
        background: {
          start: (job) =>
            Effect.andThen(
              Effect.promise(() => files.save(job)),
              start(job),
            ),
        },
      }),
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
    // The section is written for the tools on offer before the request's are chosen: once they are, it goes with the
    // tool, so a mode without it (an explorer) is told nothing of agents.
    yield* owner.on(
      AgentRequestHook,
      (draft, next) =>
        Effect.map(next(draft), (plan) => (offers(plan.tools) ? plan : { ...plan, sections: plan.sections.filter((section) => section.id !== SECTION) })),
      { phase: "select" },
    );

    // What a reload or a restart left: each background agent waited on again, its thread told when it finishes.
    for (const job of yield* Effect.promise(() => files.all())) yield* start(job);
  },
});
