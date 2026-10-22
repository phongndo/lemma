import { stat } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Result, Schedule, Schema, Semaphore } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { callHere } from "@lemma/cli";
import { HostError, InteractionError } from "@lemma/contracts";
import type { Interaction } from "@lemma/contracts";
import { AgentChannels, ModeChannels, MODES_PLUGIN, offeredFor } from "@lemma/agent";
import type { ModeInfo, PromptOutcome, TurnOptions, WhenBusy } from "@lemma/agent";
import { branchOf, SessionChannels } from "@lemma/sessions";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";
import { ToolResult } from "@lemma/tools";
import type { Tool, ToolContext } from "@lemma/tools";
import { boundOutput, resolveToCwd } from "@lemma/tools/files";
import type { Job } from "./jobs.ts";
import { choiceOf, depthOf, firstLine, forkPoint, lastTurnOptions, noticeIdOf, requestIdOf, SOURCE, summarize, thinkingOf } from "./lineage.ts";

type Reader = Context.Service.Shape<typeof Registries>;
type Asker = Context.Service.Shape<typeof Interaction>;

/** The tool's name, which its web half's view is keyed by. */
export const DELEGATE = "delegate";

/** Whether a call failed with `code`: as the transport says it (`HostError`), or as a domain does in the host (a reason). */
export const isCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof HostError ? error.code === code : typeof error === "object" && error !== null && (error as { readonly reason?: unknown }).reason === code;

const sentence = (text: string): string => (/[.!?)]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** What a failed call says to the model: the channel and the code. */
export const failure = (id: string, error: unknown): string => {
  if (error instanceof HostError) return `"${id}" failed (${error.code}): ${sentence(error.message)}`;
  const tagged = error as { readonly _tag?: unknown; readonly reason?: unknown; readonly message?: unknown } | null;
  if (typeof tagged === "object" && tagged !== null && typeof tagged._tag === "string") {
    const code = typeof tagged.reason === "string" ? tagged.reason : tagged._tag;
    return `"${id}" failed (${code}): ${sentence(typeof tagged.message === "string" ? tagged.message : code)}`;
  }
  return `"${id}" failed: ${sentence(error instanceof Error ? error.message : String(error))}`;
};

export const DelegateInput = Schema.Struct({
  prompt: Schema.NonEmptyString.annotate({
    description: "The task, as the agent's first prompt: all a new agent knows of it, so say everything it needs. With sessionId, a message to that agent",
  }),
  title: Schema.optional(
    Schema.String.annotate({ description: "The agent's name: its thread's title, in a few words (default: the prompt's first line). Not with sessionId" }),
  ),
  mode: Schema.optional(
    Schema.String.annotate({
      description:
        "The agent's mode, one of those offered to agents (listed with the tool's use in your instructions); default: the default mode. Not with sessionId",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({ description: "The agent's model, as \"provider/id\" (default: its mode's, else this thread's). Not with sessionId" }),
  ),
  context: Schema.optional(
    Schema.Literals(["fresh", "fork"]).annotate({
      description:
        "fresh (default): the agent sees only the prompt. fork: it starts from this thread's finished turns, in its mode and model, so it knows what was said. Not with sessionId",
    }),
  ),
  background: Schema.optional(
    Schema.Boolean.annotate({
      description: "Answer at once, the agent working on; you are told when it finishes, so do not wait or poll for it (default: wait for its answer)",
    }),
  ),
  sessionId: Schema.optional(
    Schema.String.annotate({
      description:
        "An agent this thread started (its sessionId): the prompt goes to it, as a follow-up, instead of to a new agent. It keeps its own title, mode, model, context, and cwd, so give none of them",
    }),
  ),
  cwd: Schema.optional(
    Schema.String.annotate({ description: "The agent's directory, relative to this thread's (default: this thread's). Not with sessionId" }),
  ),
});
export type DelegateInput = typeof DelegateInput.Type;

/** The inputs a follow-up (`sessionId`) refuses: the agent it goes to keeps its own. */
const NEW_AGENT_ONLY = ["title", "mode", "model", "context", "cwd"] as const;

/** How the agent's turn ended, as its log says: `running` for one working in the background, `handled`/`refused` when a plugin answered the prompt itself. */
export const Ended = Schema.Literals(["done", "error", "cancelled", "max-steps", "handled", "refused", "running"]);
export type Ended = typeof Ended.Type;

export const DelegateOutput = Schema.Struct({
  sessionId: Schema.String,
  /** The agent's name: its thread's title. */
  title: Schema.String,
  ended: Ended,
  /** The agent's last reply: its answer (empty while it works in the background). */
  answer: Schema.String,
  error: Schema.optional(Schema.String),
});
export type DelegateOutput = typeof DelegateOutput.Type;

/** What a delegating call's result keeps for its views (`details`): the agent, and how it was started. */
export interface DelegateDetails {
  readonly sessionId: string;
  readonly title: string;
  readonly mode?: string;
  readonly background?: true;
  readonly fork?: true;
  readonly followUp?: true;
  readonly ended: Ended;
  /** The answer's start, for a view to show beside the agent (`PREVIEW_CHARS`); the model reads the whole. */
  readonly preview?: string;
  /**
   * A background agent's last seq when the call answered, holding only what the call put there: until its log passes
   * it, its prompt waits for a slot (`Job.emptyAt`).
   */
  readonly emptyAt?: number;
}

/** Characters of an answer a call's details keep for its views. */
export const PREVIEW_CHARS = 400;

/** Background agents: kept (a file) and waited on as the plugin's own work, telling the thread when each finishes. */
export interface Background {
  readonly start: (job: Job) => Effect.Effect<void>;
}

export interface DelegateOptions {
  readonly registries: Reader;
  readonly interaction: Asker;
  /** Agents working at once at each depth; more wait for one to end. */
  readonly maxDelegations: number;
  /** How deep delegations go: an agent this many levels down hands no task on. */
  readonly maxDepth: number;
  /** Ask the person before each new agent. */
  readonly confirm: boolean;
  /** Text characters of an answer the model reads. */
  readonly budget: number;
  readonly background: Background;
  /** The slots at each depth, shared with the background agents' waiting. */
  readonly slotsAt: (depth: number) => Semaphore.Semaphore;
  /** The waited-on agents whose prompts are being placed, by agent: the request id Stop withdraws (`delegate.stop`). */
  readonly placing: Map<string, string>;
}

/** Slots at each depth, apart: a parent holds one until its turn ends, which may wait on its own agents' slots. */
export const depthSlots = (maxDelegations: number) => {
  const levels = new Map<number, Semaphore.Semaphore>();
  return (depth: number) => {
    let slots = levels.get(depth);
    if (slots === undefined) levels.set(depth, (slots = Semaphore.makeUnsafe(maxDelegations)));
    return slots;
  };
};

const textResult = (text: string, isError = true) => new ToolResult({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/**
 * Places the prompt, as a job says to, and waits for the turn that places it to end. Placing again with the same request
 * id never places it twice, so a job resumed after a restart waits on the turn it started. Interrupted, it cancels the
 * turn when `cancelOnInterrupt` says so (a call the person stopped), and otherwise only stops waiting (a plugin
 * reloading).
 */
export const place = (
  registries: Reader,
  job: Pick<Job, "child" | "prompt" | "options" | "whenBusy" | "requestId">,
  cancelOnInterrupt: boolean,
): Effect.Effect<PromptOutcome, unknown> =>
  callHere(registries, AgentChannels.prompt, {
    sessionId: job.child,
    content: [{ type: "text", text: job.prompt }],
    requestId: job.requestId,
    ...(job.whenBusy === undefined ? {} : { whenBusy: job.whenBusy }),
    ...(job.options === undefined ? {} : { options: job.options }),
  }).pipe(Effect.onInterrupt(() => (cancelOnInterrupt ? Effect.ignore(stopTurn(registries, job.child, job.requestId)) : Effect.void)));

/**
 * Stops an agent's own work for `requestId`: its prompt taken out of the queue while it waits behind another turn (a
 * person's, a follow-up's), else its turn cancelled. Cancelling first would end that other turn instead. Answers
 * whether the prompt was withdrawn.
 */
export const stopTurn = (registries: Reader, child: string, requestId: string): Effect.Effect<boolean, unknown> =>
  Effect.flatMap(callHere(registries, AgentChannels.withdraw, { sessionId: child, requestId }), (withdrawn) =>
    withdrawn ? Effect.succeed(true) : Effect.as(callHere(registries, AgentChannels.cancel, { sessionId: child }), false),
  );

/** Whether a call failed because the session it named is not there: the sessions plugin's own `NotFound`, not a channel no plugin serves. */
export const sessionGone = (error: unknown): boolean => !(error instanceof HostError) && isCode("NotFound")(error);

/** How an agent's turn ended, and its answer: what its call resolves to, and its notice tells. */
export interface Settled {
  readonly ended: Ended;
  readonly answer: string;
  readonly error?: string;
}

/** How a placed prompt's turn ended, and its answer, from the agent's log. */
export const outcomeOf = (registries: Reader, child: string, requestId: string, outcome: PromptOutcome): Effect.Effect<Settled, unknown> =>
  Effect.gen(function* () {
    if (outcome.kind === "handled") return { ended: "handled", answer: outcome.message ?? "" };
    if (outcome.kind === "refused") return { ended: "refused", answer: "", error: `${outcome.by} refused the prompt: ${outcome.reason}` };
    const [info, events] = yield* Effect.all(
      [callHere(registries, SessionChannels.get, { sessionId: child }), callHere(registries, SessionChannels.events, { sessionId: child })],
      { concurrency: "unbounded" },
    );
    const turn = summarize(info, events, requestId);
    return { ended: turn.reason ?? "error", answer: turn.answer, ...(turn.error === undefined ? {} : { error: turn.error }) };
  });

/**
 * Deletes an agent its call made that holds nothing since (`emptyAt`): no prompt placed in it, nobody wrote to it, so
 * no agent is left behind. Whether it went: one that holds anything, or that cannot be read, stays.
 */
export const discard = (registries: Reader, sessionId: string, emptyAt: number | undefined): Effect.Effect<boolean> =>
  emptyAt === undefined
    ? Effect.succeed(false)
    : Effect.gen(function* () {
        const info = yield* callHere(registries, SessionChannels.get, { sessionId });
        if (info.lastSeq !== emptyAt) return false;
        // The agent holds the session a moment longer while it settles a refusal: deleting waits that out.
        yield* callHere(registries, SessionChannels.delete, { sessionId }).pipe(
          Effect.retry({ while: isCode("Busy"), schedule: Schedule.spaced("100 millis"), times: 30 }),
        );
        return true;
      }).pipe(Effect.orElseSucceed(() => false));

/** The modes offered to agents in `cwd`, by name; none when the modes plugin is off. */
const agentModes = (registries: Reader, cwd: string): Effect.Effect<readonly ModeInfo[]> =>
  callHere(registries, ModeChannels.list, { cwd }).pipe(
    Effect.map((answer) => answer.modes.filter((mode) => offeredFor(mode, "agent"))),
    Effect.orElseSucceed(() => [] as readonly ModeInfo[]),
  );

/** The modes offered to agents in `cwd`, as the tool's prompt section lists them. */
export const modesSection = (registries: Reader, cwd: string): Effect.Effect<string | undefined> =>
  Effect.map(agentModes(registries, cwd), (modes) =>
    modes.length === 0
      ? undefined
      : [
          "Modes you can give an agent you hand a task to (`delegate`'s `mode`):",
          ...modes.map((mode) => `- ${mode.name}${mode.description === undefined ? "" : `: ${mode.description}`}`),
        ].join("\n"),
  );

const permission = (interaction: Asker, title: string, detail: string): Effect.Effect<string | undefined> =>
  interaction.confirm(title, detail).pipe(
    Effect.map((allowed) => (allowed ? undefined : "The person declined it.")),
    Effect.catch((error: InteractionError) =>
      Effect.succeed(error.reason === "Dismissed" ? "The person dismissed the question." : `Nobody could approve it (${error.message}).`),
    ),
  );

/**
 * The caller's branch, as its call's turn reached it: how deep it is, what an agent forks, and whose model it
 * inherits. A call outside any session (a test's, a script's own) has none; one the store fails to read fails the call,
 * since its depth would read as the top.
 */
const callerBranch = (registries: Reader, context: ToolContext): Effect.Effect<readonly SessionEvent[], unknown> =>
  callHere(registries, SessionChannels.events, { sessionId: context.sessionId }).pipe(
    Effect.map((events) => branchOf(events, context.leafId ?? events.at(-1)?.id)),
    Effect.catchIf(isCode("NotFound"), () => Effect.succeed([] as readonly SessionEvent[])),
  );

/** The agent a call works with, and, when the call made it, its last seq while it held nothing else (`Job.emptyAt`). */
interface Agent {
  readonly child: SessionInfo;
  readonly emptyAt?: number;
}

/**
 * `delegate`: hands a task to an agent, a thread of its own working for this one (`SessionInfo.parent`), in a mode
 * offered to agents, starting fresh or from this thread's finished turns; waits for its answer, or with `background`
 * answers at once and tells the thread when it finishes (`ModelNotice`). With `sessionId`, a follow-up to an agent this
 * thread started. Run again with the same call (a restart), it finds the agent it started and waits on the same turn.
 */
export const delegateTool = (options: DelegateOptions): Tool<DelegateInput> => {
  const { registries } = options;

  const output = (result: DelegateOutput, details: DelegateDetails, context: ToolContext, isError: boolean) =>
    Effect.promise(async () => {
      const text =
        result.ended === "running"
          ? `Started agent "${result.title}" (session ${result.sessionId}) in the background. You are told when it finishes: do not wait or poll for it.`
          : [
              `Agent "${result.title}" (session ${result.sessionId}) ended: ${result.ended}.`,
              result.error === undefined ? "" : `Error: ${result.error}`,
              result.answer,
            ]
              .filter((part) => part !== "")
              .join("\n\n");
      const { content } = await boundOutput([{ type: "text", text }], { budget: options.budget, maxResultChars: context.maxResultChars, name: "delegate" });
      return new ToolResult({ content: [...content], structured: result, details, ...(isError ? { isError: true } : {}) });
    });

  /**
   * Waits on the agent's turn for `job`, answering as the call does. A prompt the agent refuses before placing it (an
   * unknown model) leaves an agent it made holding nothing, which goes; one that holds work stays, and is named.
   */
  const waitOn = (job: Job, base: Omit<DelegateDetails, "ended">, context: ToolContext) =>
    Effect.gen(function* () {
      options.placing.set(job.child, job.requestId);
      const placed = yield* Effect.result(place(registries, job, true)).pipe(Effect.ensuring(Effect.sync(() => options.placing.delete(job.child))));
      if (Result.isFailure(placed)) {
        const reason = failure("agent.prompt", placed.failure);
        if (yield* discard(registries, job.child, job.emptyAt)) return textResult(`No agent was started: ${reason}`);
        return yield* output(
          { sessionId: job.child, title: job.title, ended: "error", answer: "", error: reason },
          { ...base, ended: "error", preview: reason.slice(0, PREVIEW_CHARS) },
          context,
          true,
        );
      }
      const settled = yield* outcomeOf(registries, job.child, job.requestId, placed.success);
      const result: DelegateOutput = { sessionId: job.child, title: job.title, ...settled };
      const preview = (settled.error ?? settled.answer).trim().slice(0, PREVIEW_CHARS);
      return yield* output(
        result,
        { ...base, ended: settled.ended, ...(preview === "" ? {} : { preview }) },
        context,
        settled.ended !== "done" && settled.ended !== "handled",
      );
    });

  /** A follow-up: the prompt to an agent this thread started, which steers it while it works. */
  const followUp = (sessionId: string, input: DelegateInput, context: ToolContext, depth: number) =>
    Effect.gen(function* () {
      const info = yield* callHere(registries, SessionChannels.get, { sessionId }).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.parent?.sessionId !== context.sessionId)
        return textResult(`No message was sent: ${sessionId} is not an agent this thread started. Start one by leaving sessionId out.`);
      const title = info.title ?? firstLine(input.prompt);
      const job: Job = {
        parent: context.sessionId,
        child: sessionId,
        prompt: input.prompt,
        whenBusy: "steer",
        requestId: requestIdOf(context.toolCallId),
        depth,
        noticeId: noticeIdOf(context.toolCallId),
        title,
        followUp: true,
      };
      const base = { sessionId, title, followUp: true as const };
      if (input.background !== true) return yield* waitOn(job, base, context);
      yield* options.background.start(job);
      return yield* output({ sessionId, title, ended: "running", answer: "" }, { ...base, background: true, ended: "running" }, context, false);
    });

  return {
    name: DELEGATE,
    description:
      "Hands a task to an agent: a thread of its own, which works on it and answers. Several calls in one response run at once. With background, it answers at once and you are told when the agent finishes. Say everything the agent needs: unless context is fork, it sees only the prompt, and a fork gets this thread's finished turns only, not this turn's work so far.",
    input: DelegateInput,
    output: DelegateOutput,
    // Run again after a restart, it finds the agent it started and waits on the same turn.
    replay: "safe",
    // Agents work at once: a response's delegations start together, `maxDelegations` at a time.
    parallel: "safe",
    // Its calls show the reader the agent they started, outside the fold, and a script keeps them to show so too.
    display: true,
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.sessionId !== undefined) {
          const given = NEW_AGENT_ONLY.filter((key) => input[key] !== undefined);
          if (given.length > 0) {
            const named = given.length === 1 ? given[0]! : `${given.slice(0, -1).join(", ")} and ${given.at(-1)!}`;
            return textResult(
              `No message was sent: ${named} ${given.length === 1 ? "is" : "are"} for a new agent, and a follow-up (sessionId) goes to one that keeps its own. Leave ${given.length === 1 ? "it" : "them"} out, or leave sessionId out to start a new agent.`,
            );
          }
        }
        const branch = yield* callerBranch(registries, context);
        const depth = depthOf(branch) + 1;
        if (input.sessionId !== undefined) return yield* followUp(input.sessionId, input, context, depth);
        // Not offered so deep (the `select` hook), but a script may call it all the same.
        if (depth > options.maxDepth) {
          return textResult(
            `This thread is an agent ${depth - 1} ${depth === 2 ? "level" : "levels"} deep, as deep as delegations go (${options.maxDepth}): do the task here.`,
          );
        }
        const fork = input.context === "fork";
        if (fork && input.mode !== undefined) return textResult("No agent was started: a forked agent keeps this thread's mode, so it takes none of its own.");
        // Relative to this thread's directory, as its other tools' paths are.
        const asked = input.cwd === undefined ? undefined : resolveToCwd(input.cwd, context.cwd);
        // A fork is a copy of this thread, so it works where this thread does.
        if (fork && asked !== undefined && asked !== path.resolve(context.cwd))
          return textResult("No agent was started: a forked agent works in this thread's directory, so it takes no cwd of its own.");
        const cwd = fork || asked === undefined ? context.cwd : asked;
        // A directory that is not there would give the agent nothing to work in: refused before a session is made.
        if (asked !== undefined && !fork) {
          const isDirectory = yield* Effect.promise(() =>
            stat(cwd).then(
              (found) => found.isDirectory(),
              () => false,
            ),
          );
          if (!isDirectory) return textResult(`No agent was started: ${cwd} is not a directory on this host.`);
        }
        let chosen: ModeInfo | undefined;
        if (input.mode !== undefined) {
          const modes = yield* agentModes(registries, cwd);
          chosen = modes.find((mode) => mode.name === input.mode);
          if (chosen === undefined) {
            const offered = modes.map((mode) => mode.name).join(", ");
            return textResult(`No agent was started: no mode "${input.mode}" is offered to agents here${offered === "" ? "" : ` (offered: ${offered})`}.`);
          }
        }
        const inherited = lastTurnOptions(branch);
        const parent = { sessionId: context.sessionId, toolCallId: context.toolCallId };
        // Run again (a restart cut the call off), the agent this call started is found, and waited on: among those in
        // its directory, where it was made.
        const existing = (yield* callHere(registries, SessionChannels.list, { cwd }).pipe(Effect.orElseSucceed(() => [] as readonly SessionInfo[]))).find(
          (info) => info.parent?.sessionId === parent.sessionId && info.parent.toolCallId === parent.toolCallId,
        );
        if (existing === undefined && options.confirm) {
          const refused = yield* permission(options.interaction, "Let the agent hand a task to an agent?", `${input.prompt}\n\nin ${cwd}`);
          if (refused !== undefined) return textResult(`No agent was started: ${refused}`);
        }
        const forkAt = fork ? forkPoint(branch) : undefined;
        const title = input.title?.trim() || firstLine(input.prompt);
        /** The agent: the one this call started before, else one made now, titled. */
        const agent: Effect.Effect<Agent, unknown> =
          existing !== undefined
            ? Effect.succeed({ child: existing })
            : Effect.gen(function* () {
                const made = yield* forkAt === undefined
                  ? callHere(registries, SessionChannels.create, { cwd, parent })
                  : callHere(registries, SessionChannels.fork, { sessionId: context.sessionId, eventId: forkAt, parent });
                const titled = yield* callHere(registries, SessionChannels.setTitle, { sessionId: made.id, title }).pipe(Effect.orElseSucceed(() => made));
                return { child: titled, emptyAt: titled.lastSeq };
              });
        const model = input.model ?? chosen?.model ?? inherited.model;
        const thinking = thinkingOf(chosen?.thinking) ?? (input.model === undefined && chosen?.model === undefined ? inherited.thinking : undefined);
        const turnOptions: TurnOptions = {
          ...(model === undefined ? {} : { model }),
          ...(thinking === undefined ? {} : { thinking }),
          plugins: {
            // Logged with its first turn, how deep it is: what its own delegations count from.
            [SOURCE]: choiceOf(depth),
            // A forked agent's mode is this thread's, which its first turn logged.
            ...(forkAt === undefined && input.mode !== undefined ? { [MODES_PLUGIN]: input.mode } : {}),
          },
        };
        // Queued behind a turn running in it (a person writing to it while it waited for a slot), so the task still runs.
        const whenBusy: WhenBusy = "follow-up";
        const jobOf = ({ child, emptyAt }: Agent): Job => ({
          parent: context.sessionId,
          child: child.id,
          prompt: input.prompt,
          options: turnOptions,
          whenBusy,
          requestId: requestIdOf(context.toolCallId),
          depth,
          noticeId: noticeIdOf(context.toolCallId),
          title,
          ...(emptyAt === undefined ? {} : { emptyAt }),
        });
        const base = (child: SessionInfo): Omit<DelegateDetails, "ended"> => ({
          sessionId: child.id,
          title,
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(forkAt === undefined ? {} : { fork: true }),
        });
        if (input.background === true) {
          // Made now, so the call names it; its prompt waits for a slot in the plugin's own work.
          const made = yield* agent;
          yield* options.background.start(jobOf(made));
          return yield* output(
            { sessionId: made.child.id, title, ended: "running", answer: "" },
            { ...base(made.child), background: true, ended: "running", ...(made.emptyAt === undefined ? {} : { emptyAt: made.emptyAt }) },
            context,
            false,
          );
        }
        // Made once a slot is free, so a call stopped while it waits leaves nothing.
        return yield* options.slotsAt(depth).withPermits(1)(
          Effect.gen(function* () {
            const made = yield* agent;
            // Stopped before its prompt was placed: an agent that holds nothing goes.
            return yield* waitOn(jobOf(made), base(made.child), context).pipe(Effect.onInterrupt(() => discard(registries, made.child.id, made.emptyAt)));
          }),
        );
      }).pipe(
        Effect.catch((error) => Effect.succeed(textResult(failure(DELEGATE, error)))),
        Effect.catchDefect((defect) => Effect.succeed(textResult(failure(DELEGATE, defect)))),
      ),
  };
};
