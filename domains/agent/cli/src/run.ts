import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Deferred, Duration, Effect, Fiber, Semaphore, Stream } from "effect";
import type { Context } from "effect";
import type { Events, Registries } from "@lemma/core";
import { HostError, Notice } from "@lemma/contracts";
import type { ChannelDeclaration, NoticePayload } from "@lemma/contracts";
import { AgentChannels, WhenBusy } from "@lemma/agent";
import type { AgentActivity, AgentView, PromptContent, PromptOutcome } from "@lemma/agent";
import { contentText, ThinkingLevel } from "@lemma/llm";
import type { AssistantMessage, ImageContent, TextContent } from "@lemma/llm";
import { branchOf, SessionChannels, trajectory } from "@lemma/sessions";
import type { SessionEvent, SessionInfo, SessionLogUpdate } from "@lemma/sessions";
import { callHere, CliCommandError, defineCliCommand, followHere, formatDuration, formatUsage } from "@lemma/cli";
import type { CliContext, CliFile, CliResult } from "@lemma/cli";

type Reader = Context.Service.Shape<typeof Registries>;

/** Where a turn's view prints: the command's output. */
export interface TurnIo {
  /** Text as it is. */
  readonly write: (text: string) => void;
  /** One JSON value on a line. */
  readonly json: (value: unknown) => void;
}

export const noticeLine = (event: { readonly notice: NoticePayload }) => {
  const notice = event.notice;
  const links = notice.links?.map((link) => ` ${link.label === undefined ? link.url : `${link.label}: ${link.url}`}`).join("") ?? "";
  return `[${notice.level}]${notice.source === undefined ? "" : ` ${notice.source}:`} ${notice.message}${links}`;
};

// ------------------------------------------------------------------ the result

/**
 * How a turn ended, from the log: the reply, the reason, usage, and time. The
 * turn is the one that placed the prompt `requestId` (a queued prompt runs in
 * a later turn, a steer in the running one), else the session's last.
 */
export const summarize = (info: SessionInfo, events: readonly SessionEvent[], requestId?: string) => {
  const placed = events.find((event) => event.data.type === "message" && event.data.requestId !== undefined && event.data.requestId === requestId);
  const turnId = placed?.data.type === "message" ? placed.data.turnId : undefined;
  // On that turn's own branch, through its last event: a checkout since may have left it off the session's.
  const last = turnId === undefined ? undefined : events.filter((event) => "turnId" in event.data && event.data.turnId === turnId).at(-1);
  const turns = trajectory(branchOf(events, last?.id ?? info.leaf));
  const turn = turnId === undefined ? turns.at(-1) : turns.find((candidate) => candidate.turnId === turnId);
  const response = turn?.steps.filter((step) => step.response !== undefined).at(-1)?.response;
  return {
    session: info.id,
    turn: turn?.turnId,
    reason: turn?.end?.reason ?? "running",
    ...(turn?.end?.error === undefined ? {} : { error: turn.end.error }),
    steps: turn?.steps.length ?? 0,
    toolCalls: turn?.steps.reduce((sum, step) => sum + step.tools.length, 0) ?? 0,
    usage: turn?.usage,
    duration: turn?.endedAt === undefined ? undefined : turn.endedAt - turn.startedAt,
    text: response === undefined ? "" : contentText(response.message.content),
  };
};
export type TurnResult = ReturnType<typeof summarize>;

/** The reply (unless it was streamed) and a one-line summary of how the turn ended. */
export const formatTurnResult = (turn: TurnResult, withText: boolean): string => {
  const summary = [
    `turn ${turn.reason}`,
    `${turn.steps} step${turn.steps === 1 ? "" : "s"}`,
    `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}`,
    ...(turn.usage === undefined ? [] : [formatUsage(turn.usage)]),
    ...(turn.duration === undefined ? [] : [formatDuration(turn.duration)]),
    `session ${turn.session}`,
  ].join(" · ");
  return [...(withText && turn.text ? [turn.text.trimEnd(), ""] : []), `── ${summary}`, ...(turn.error === undefined ? [] : [`error: ${turn.error}`])].join(
    "\n",
  );
};

/** The session's info and log, read once. */
export const readSession = (registries: Reader, sessionId: string) =>
  Effect.all([callHere(registries, SessionChannels.get, { sessionId }), callHere(registries, SessionChannels.events, { sessionId })], {
    concurrency: "unbounded",
  });

const handledResult = (outcome: Extract<PromptOutcome, { readonly kind: "handled" }>): CliResult => ({
  json: { type: "handled", by: outcome.by, ...(outcome.message === undefined ? {} : { message: outcome.message }) },
  text: outcome.message === undefined || outcome.message === "" ? `${outcome.by} handled the prompt` : outcome.message,
});

const resultOf = (turn: TurnResult, json: boolean, followed: boolean, streamed: boolean): CliResult => ({
  json: json && followed ? { type: "result", ...turn } : turn,
  text: formatTurnResult(turn, !streamed),
  ...(turn.reason === "done" ? {} : { failed: true }),
});

// ------------------------------------------------------------------ the prompt

/**
 * `agent.prompt`, which answers when the turn that places the prompt ends.
 * It is `repeatable`: made again with the same `requestId`, it waits for that
 * turn, or places it if it never was, and never places it twice. So when the
 * agent reloads meanwhile, it is made again on the replacement
 * (`callHere`). A plugin that handled the prompt instead answers at once; one
 * that refused it fails it.
 */
type Prompt = typeof AgentChannels.prompt extends ChannelDeclaration<"call", infer Payload> ? Payload : never;

const place = (registries: Reader, payload: Prompt) =>
  callHere(registries, AgentChannels.prompt, payload).pipe(
    Effect.flatMap((outcome): Effect.Effect<Exclude<PromptOutcome, { readonly kind: "refused" }>, CliCommandError> =>
      outcome.kind === "refused"
        ? Effect.fail(new CliCommandError({ reason: "Refused", message: `${outcome.by} refused the prompt: ${outcome.reason}`, subject: outcome.by }))
        : Effect.succeed(outcome),
    ),
    Effect.mapError((error) =>
      error instanceof HostError && error.code === "Withdrawn" && error.subject === AgentChannels.prompt.id
        ? new CliCommandError({
            reason: "Withdrawn",
            message: `The agent stopped while it had the prompt, and nothing answers for "${AgentChannels.prompt.id}" now; it may take the prompt still, once it is back`,
            subject: AgentChannels.prompt.id,
          })
        : error,
    ),
  );

/**
 * `run --follow`, on the host: the agent's activity and the session's log are
 * followed from before the prompt is sent, so nothing of its turn is missed,
 * and the turn is shown as they report it (`turnView`). Once the prompt's
 * call has answered, what the log has beyond what was followed shows, read
 * once with what the result reads. A stream its plugin's reload withdrew is
 * opened again (`followHere`): the log from the last event shown, the
 * activity caught up from `agent.view`. The host's notices show as they come.
 */
const followed = (
  registries: Reader,
  events: Context.Service.Shape<typeof Events>,
  context: CliContext,
  sessionId: string,
  requestId: string,
  send: Effect.Effect<Exclude<PromptOutcome, { readonly kind: "refused" }>, unknown>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const view = turnView(
        { write: (text) => context.out.text(text), json: context.out.json },
        context.json,
        sessionId,
        requestId,
        callHere(registries, AgentChannels.view, { sessionId }),
      );
      // One element at a time, whichever stream it comes from, so what is shown stays in order.
      const lock = yield* Semaphore.make(1);
      const serial = <E>(effect: Effect.Effect<void, E>) => lock.withPermits(1)(effect);
      yield* Effect.forkScoped(
        Stream.runForEach(events.stream(Notice, { buffer: 64 }), (notice) => serial(Effect.sync(() => view.notice({ type: "notice", notice })))),
      );
      // Each stream's first element says it hears everything from then on: the prompt goes once both have it.
      const opened = yield* Deferred.make<void>();
      const logOpened = yield* Deferred.make<void>();
      const activity = yield* Effect.forkScoped(
        followHere(
          registries,
          AgentChannels.activity,
          () => undefined,
          (element) => Effect.andThen(serial(view.activity(element)), Deferred.succeed(opened, undefined)),
        ),
      );
      const log = yield* Effect.forkScoped(
        followHere(
          registries,
          SessionChannels.log,
          () => ({ sessionId, after: view.logSeq() }),
          (update) => Effect.andThen(serial(view.log(update)), Deferred.succeed(logOpened, undefined)),
        ),
      );
      const failedEarly = Effect.andThen(
        Effect.raceFirst(Fiber.join(activity), Fiber.join(log)),
        Effect.fail(new CliCommandError({ reason: "Failed", message: "The agent's or the session's stream ended before the prompt was sent" })),
      );
      yield* Effect.raceFirst(Effect.all([Deferred.await(opened), Deferred.await(logOpened)]), failedEarly);
      const outcome = yield* Effect.raceFirst(
        send,
        // Either stream failing (not withdrawn, which reopens it) fails the command.
        Effect.andThen(Effect.raceFirst(Fiber.join(activity), Fiber.join(log)), Effect.never),
      );
      if (outcome.kind === "handled") {
        yield* serial(Effect.andThen(Fiber.interrupt(activity), Fiber.interrupt(log)));
        view.close();
        return handledResult(outcome);
      }
      // `turn-ended` may trail the reply (each kind of the agent's output comes in its own order): what came before it too.
      yield* view.ended.pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
      yield* serial(Effect.andThen(Fiber.interrupt(activity), Fiber.interrupt(log)));
      const [info, all] = yield* readSession(registries, sessionId);
      view.catchUp(all);
      view.close();
      return resultOf(summarize(info, all, requestId), context.json, true, context.json || view.streamed());
    }),
  );

/**
 * `lemma run <session|new> <prompt…>`: sends a prompt and waits for the turn
 * that places it; `--follow` shows it as it runs. The host runs it, so a
 * client whose connection drops rejoins it where it left off, and a reload of
 * the agent goes on as the prompt's call does (`callHere`).
 */
export const runCommand = (registries: Reader, events: Context.Service.Shape<typeof Events>) =>
  defineCliCommand({
    path: ["run"],
    summary: "Send a prompt to a session and wait for the turn to end; --follow shows it as it runs",
    description:
      "The turn that places it is the one reported: a queued prompt's runs later, a steer's is the running one. A prompt a plugin handled instead of placing prints what the plugin said. --request-id sends it once: the same id again waits for, or reports, the turn that placed it. Questions its tools ask (an approval) are answered as --questions says.",
    args: [
      { name: "session", description: "A session's id, or new for a new one (in --cwd)", required: true },
      { name: "prompt", description: "The prompt", variadic: true },
    ],
    flags: {
      follow: { type: "boolean", short: "f", description: "Stream the turn: text, tool calls, results (NDJSON with --json)" },
      model: { type: "string", placeholder: "provider/model", description: "Model for this turn (see lemma models)" },
      thinking: { type: "string", values: ThinkingLevel.literals, description: "Thinking level for this turn" },
      image: { type: "file", multiple: true, accept: ["image/png", "image/jpeg", "image/gif", "image/webp"], description: "Attach an image" },
      cwd: { type: "string", placeholder: "dir", description: "Directory for a new session (default: here)" },
      "when-busy": {
        type: "string",
        values: WhenBusy.literals,
        description: "While a turn runs: the next turn (follow-up, the default), join it after its current step (steer), or fail Busy (reject)",
      },
      steer: { type: "boolean", description: "Same as --when-busy steer" },
      "request-id": {
        type: "string",
        placeholder: "id",
        description: "Send it exactly once: the same id again waits for (or reports) the turn that placed it",
      },
    },
    examples: ['lemma run new "fix the failing test" --follow', 'lemma run 01J… --steer "also update the docs"'],
    run: (context) =>
      Effect.gen(function* () {
        const { args, flags, out } = context;
        if (flags.steer && flags["when-busy"] !== undefined && flags["when-busy"] !== "steer")
          return yield* new CliCommandError({ reason: "Usage", message: "Use either --steer or --when-busy" });
        const text = args.prompt.join(" ").trim();
        const images = flags.image.map((file: CliFile): ImageContent => ({ type: "image", data: file.data, mimeType: file.mimeType ?? "image/png" }));
        if (text === "" && images.length === 0) return yield* new CliCommandError({ reason: "Usage", message: "run needs a prompt" });
        const content: PromptContent = [...(text === "" ? [] : [{ type: "text", text } satisfies TextContent]), ...images];
        const sessionId =
          args.session === "new" ? (yield* callHere(registries, SessionChannels.create, { cwd: resolve(context.cwd, flags.cwd ?? ".") })).id : args.session;
        if (args.session === "new" && !context.json) out.line(`lemma: session ${sessionId}`, { err: true });
        // Always an id: the result and `--follow` are about the turn that places this prompt, which a queue can delay.
        const requestId = flags["request-id"] ?? randomUUID();
        // The session it made, never `new` again: that would make a second one and place the prompt there.
        out.rerun([
          "run",
          sessionId,
          ...(text === "" ? [] : [text]),
          ...flags.image.flatMap((file: CliFile) => ["--image", file.name]),
          "--request-id",
          requestId,
          ...(flags.follow ? ["--follow"] : []),
        ]);
        // Its tools ask as its session: the client answers those.
        out.answer(`session:${sessionId}`);
        const whenBusy = flags.steer ? "steer" : flags["when-busy"];
        const turn = { ...(flags.model === undefined ? {} : { model: flags.model }), ...(flags.thinking === undefined ? {} : { thinking: flags.thinking }) };
        const send = place(registries, {
          sessionId,
          content,
          requestId,
          ...(Object.keys(turn).length > 0 ? { options: turn } : {}),
          ...(whenBusy === undefined ? {} : { whenBusy }),
        });
        if (flags.follow) return yield* followed(registries, events, context, sessionId, requestId, send);
        const outcome = yield* send;
        if (outcome.kind === "handled") return handledResult(outcome);
        const [info, log] = yield* readSession(registries, sessionId);
        return resultOf(summarize(info, log, requestId), context.json, false, false);
      }),
  });

// ------------------------------------------------------------------ following a turn

type Block = AssistantMessage["content"][number];
type ToolOutputElement = Extract<AgentActivity, { readonly type: "tool-output" }>;
type DeltaElement = Extract<AgentActivity, { readonly type: "delta" }>;

/** Activity elements held for the log to place, at most: the oldest go first. */
const HELD = 1024;

const indexed = (content: AssistantMessage["content"]) => content.map((block, index) => ({ index, block }));

/**
 * What `run --follow` shows of the turn that places its prompt, from what
 * the session's log and the agent's activity report. The log says in order
 * what the turn did; the activity is its live output, each kind in its own
 * order. The turn is known once the log has the prompt's message. An element
 * of activity shows once the log has placed it, its step started since the
 * prompt or its tool call shown, and is held until then: so one step's
 * answer never shows after the next one's. Output that does not follow what
 * was shown of its step (by `seq`: some was lost, or came before this command
 * joined) is skipped, and what the log has of an answer that was not shown
 * shows when the log has it; output after that is skipped too. A turn joined
 * running (the prompt was placed before: a retry), or whose activity was
 * withdrawn or cut off by a dropped connection meanwhile, is caught up from
 * `agent.view`.
 *
 * With `--json`, the activity of the turn and its events in the log print as
 * their channels send them; what the log has of an answer is in its message.
 */
export const turnView = (io: TurnIo, json: boolean, sessionId: string, requestId: string, viewOf: Effect.Effect<AgentView, unknown>) => {
  const ended = Deferred.makeUnsafe<void>();
  let midLine = false;
  const write = (text: string) => {
    if (text === "") return;
    io.write(text);
    midLine = !text.endsWith("\n");
  };
  const line = (text: string) => {
    if (midLine) {
      io.write("\n");
      midLine = false;
    }
    io.write(`${text}\n`);
  };
  const print = (value: unknown) => io.json(value);

  /** The turn that placed the prompt. */
  let ours: string | undefined;
  /** It had ended when it was found: nothing more comes, and the result prints its answer. */
  let over = false;
  let turnEnded = false;
  /** The last log event read. */
  let logSeq = 0;
  /** Text or tool calls were shown: without any, the result prints the answer. */
  let streamed = false;
  let activityOpens = 0;
  /** Its steps the log has started since the prompt, and those whose answer it has. */
  const started = new Set<string>();
  const whole = new Set<string>();
  /** Per step, the last stream event shown. */
  const shown = new Map<string, number>();
  /** What was shown of each answer block, by step and stream index: its text, or for a tool call, that it was. */
  const blocks = new Map<string, string>();
  const called = new Set<string>();
  /** How much of each tool's output was shown. */
  const printed = new Map<string, number>();
  let held: AgentActivity[] = [];
  /** The step in flight as `agent.view` had it, until the log has started it. */
  let draft: AgentView["draft"];

  const end = () => {
    turnEnded = true;
    Deferred.doneUnsafe(ended, Effect.void);
  };

  /** An answer's blocks (each with its stream index), shown as if streamed: what of them was not yet. A draft's tool call shows once it has arguments. */
  const answer = (stepId: string, content: readonly { readonly index: number; readonly block: Block }[], final: boolean) => {
    for (const { index, block } of content) {
      const key = `${stepId}:${index}`;
      const before = blocks.get(key);
      if (block.type === "text") {
        if (block.text.length <= (before?.length ?? 0) || !block.text.startsWith(before ?? "")) continue;
        blocks.set(key, block.text);
        if (json) continue;
        streamed = true;
        write(block.text.slice(before?.length ?? 0));
      } else if (block.type === "toolCall" && before === undefined && (final || Object.keys(block.arguments).length > 0)) {
        blocks.set(key, "");
        called.add(block.id);
        if (json) continue;
        streamed = true;
        line(`→ ${block.name} ${JSON.stringify(block.arguments)}`);
      }
    }
  };

  const delta = (element: DeltaElement) => {
    const { stepId, event } = element;
    shown.set(stepId, element.seq);
    if (event.type === "text-delta") blocks.set(`${stepId}:${event.index}`, (blocks.get(`${stepId}:${event.index}`) ?? "") + event.delta);
    if (event.type === "toolcall-end") {
      blocks.set(`${stepId}:${event.index}`, "");
      called.add(event.toolCall.id);
    }
    if (event.type === "text-delta" || event.type === "toolcall-end") streamed = true;
    if (json) print(element);
    else if (event.type === "text-delta") write(event.delta);
    else if (event.type === "toolcall-end") line(`→ ${event.toolCall.name} ${JSON.stringify(event.toolCall.arguments)}`);
    else if (event.type === "error") line(`✕ ${event.message.errorMessage ?? event.message.stopReason}`);
  };

  /** A tool's output, indented under its `→` line as it arrives (partial lines continue where they stopped), less what was shown. */
  const output = (element: ToolOutputElement) => {
    const seen = printed.get(element.toolCallId) ?? 0;
    const through = element.offset + element.chunk.length;
    if (through <= seen) return;
    printed.set(element.toolCallId, through);
    const fresh = element.offset < seen ? { ...element, chunk: element.chunk.slice(seen - element.offset), offset: seen } : element;
    if (json) return print(fresh);
    let text = "";
    for (const piece of fresh.chunk.split(/(?<=\n)/)) {
      text += `${midLine ? "" : "  "}${piece}`;
      midLine = !piece.endsWith("\n");
    }
    io.write(text);
  };

  /** Shows an element of the turn's activity, or skips one that is not of it or was shown: false when the log has not placed it yet. */
  const place = (element: Exclude<AgentActivity, { readonly type: "subscribed" }>): boolean => {
    if (element.sessionId !== sessionId || over || element.type === "queue-changed") return true;
    if (ours === undefined) return false;
    switch (element.type) {
      case "turn-started":
        if (element.turnId === ours && json) print(element);
        return true;
      case "turn-ended":
        if (element.turnId !== ours) return true;
        if (json) print(element);
        end();
        return true;
      case "delta": {
        const last = shown.get(element.stepId) ?? 0;
        if (element.turnId !== ours || whole.has(element.stepId) || element.seq <= last) return true;
        if (!started.has(element.stepId)) return false;
        // One that does not follow what was shown (some were lost, or came before this command joined) is skipped: the log's answer has the rest.
        if (element.seq === last + 1) delta(element);
        return true;
      }
      case "tool-output":
        if (!called.has(element.toolCallId)) return false;
        output(element);
        return true;
    }
  };

  const hold = (element: AgentActivity) => {
    held.push(element);
    if (held.length > HELD) held.shift();
  };

  /** Shows what was held that the log has placed now, in the order it came, until nothing more is. */
  const release = () => {
    while (held.length > 0) {
      const waiting = held;
      held = [];
      for (const element of waiting) if (element.type !== "subscribed" && !place(element)) held.push(element);
      if (held.length === waiting.length) return;
    }
  };

  const applyDraft = () => {
    if (draft === undefined) return;
    const { stepId, seq, blocks: content } = draft;
    draft = undefined;
    if (whole.has(stepId)) return;
    answer(stepId, content, false);
    shown.set(stepId, Math.max(shown.get(stepId) ?? 0, seq));
  };

  /** What the turn is doing now, as the agent has it: the step in flight so far, and its tools' output. */
  const rejoin = Effect.gen(function* () {
    const now = yield* viewOf;
    if (now.turnId !== ours || turnEnded) return;
    if (now.draft !== undefined && !whole.has(now.draft.stepId)) {
      draft = now.draft;
      if (started.has(draft.stepId)) applyDraft();
    }
    for (const entry of now.output) {
      const element: ToolOutputElement = {
        type: "tool-output",
        sessionId,
        toolCallId: entry.toolCallId,
        chunk: entry.output,
        offset: entry.length - entry.output.length,
      };
      if (!place(element)) hold(element);
    }
    release();
  });

  /** One event of the log, in order. */
  const record = (event: SessionEvent) => {
    if (event.seq <= logSeq) return;
    logSeq = event.seq;
    const data = event.data;
    if (ours === undefined) {
      if (data.type !== "message" || data.requestId !== requestId || data.turnId === undefined) return;
      ours = data.turnId;
      // What came before its message: its start among it.
      release();
    }
    if (over || !("turnId" in data) || data.turnId !== ours) return;
    if (json) print({ type: "appended", event });
    switch (data.type) {
      case "step-start":
        started.add(data.stepId);
        if (draft?.stepId === data.stepId) applyDraft();
        break;
      case "message":
        if (data.message.role === "assistant") {
          const stepId = data.stepId ?? "";
          answer(stepId, indexed(data.message.content), true);
          whole.add(stepId);
        } else if (data.message.role === "toolResult" && !json) {
          const message = data.message;
          const timing = data.timing;
          const first = contentText(message.content).trim().split("\n")[0] ?? "";
          line(
            `← ${message.toolName} ${message.isError ? "error" : "ok"}${timing === undefined ? "" : ` ${timing.endedAt - timing.startedAt}ms`}${first ? `: ${first.slice(0, 120)}` : ""}`,
          );
        }
        break;
      case "turn-end":
        end();
        break;
    }
  };

  /** Events of the log read at once; a turn found among them that they show has ended was over before it could be followed. */
  const read = (events: readonly SessionEvent[]) => {
    if (ours === undefined) {
      const placed = events.find((event) => event.data.type === "message" && event.data.requestId === requestId)?.data;
      const turnId = placed?.type === "message" ? placed.turnId : undefined;
      if (turnId !== undefined && events.some((event) => event.data.type === "turn-end" && event.data.turnId === turnId)) {
        ours = turnId;
        over = true;
        held = [];
        end();
      }
    }
    for (const event of events) record(event);
  };

  return {
    /** Resolves once the turn has ended, as either stream reports it. */
    ended: Deferred.await(ended),
    logSeq: () => logSeq,
    streamed: () => streamed,
    notice: (event: { readonly type: "notice"; readonly notice: NoticePayload }) => (json ? print(event) : line(noticeLine(event))),
    activity: (element: AgentActivity): Effect.Effect<void, unknown> =>
      Effect.suspend(() => {
        if (element.type === "subscribed") {
          // Opened again after the agent reloaded or the connection dropped: what its turn did meanwhile was missed.
          return activityOpens++ > 0 && ours !== undefined && !over ? rejoin : Effect.void;
        }
        if (place(element)) release();
        else hold(element);
        return Effect.void;
      }),
    log: (update: SessionLogUpdate): Effect.Effect<void, unknown> =>
      Effect.suspend(() => {
        if (update.type === "appended") {
          record(update.event);
          release();
          return Effect.void;
        }
        const found = ours === undefined;
        read(update.events);
        // Its prompt was placed before this command (a retry), and its turn runs: what it has said so far of the step in
        // flight comes first, then what was held.
        if (found && ours !== undefined && !over) return rejoin;
        release();
        return Effect.void;
      }),
    /** What the log has beyond what was followed. */
    catchUp: (events: readonly SessionEvent[]) => {
      read(events);
      release();
    },
    /** Ends a line left open. */
    close: () => {
      if (midLine) io.write("\n");
      midLine = false;
    },
  };
};
