import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Deferred, Duration, Effect, Fiber, Semaphore } from "effect";
import { AgentChannels, branchOf, contentText, SessionChannels, trajectory } from "@lemma/contracts";
import type {
  AgentActivity,
  AgentView,
  AssistantMessage,
  ChannelDeclaration,
  HostEvent,
  ImageContent,
  PromptContent,
  SessionEvent,
  SessionInfo,
  SessionLogUpdate,
  TextContent,
  TurnOptions,
} from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import { again, call, follow } from "./channels.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Connection, Failure, Io, Options, Output } from "./command.ts";
import { formatTurnResult } from "./format.ts";
import { hostEvents, noticeLine, questionHandler } from "./live.ts";

// ------------------------------------------------------------------ the prompt

const MIME: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const readImage = (io: Io, path: string) =>
  Effect.gen(function* () {
    const file = resolve(io.cwd, path);
    const mimeType = MIME[extname(file).toLowerCase()];
    if (mimeType === undefined) return yield* usage(`${path}: images must be png, jpeg, gif, or webp`);
    const data = yield* Effect.tryPromise({
      try: () => readFile(file),
      catch: () => new CliError({ code: "NotFound", message: `Cannot read image ${path}`, subject: path, exit: ExitCode.failed }),
    });
    return { type: "image", data: data.toString("base64"), mimeType } satisfies ImageContent;
  });

const turnOptions = (options: Options): TurnOptions => ({
  ...(options.model === undefined ? {} : { model: options.model }),
  ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
});

type Prompt = typeof AgentChannels.prompt extends ChannelDeclaration<"call", infer Payload> ? Payload : never;

/**
 * `agent.prompt`, which answers when the turn that places the prompt ends. It
 * is withdrawn when the agent reloads, and called again then with the same
 * `requestId`, which waits for that turn, or places the prompt if it never
 * was, and never places it twice.
 */
const prompt = (rpc: HostRpcClient, payload: Prompt) => again(rpc, AgentChannels.prompt.id, call(rpc, AgentChannels.prompt, payload));

// ------------------------------------------------------------------ the result

/**
 * How a turn ended, from the log: the reply, the reason, usage, and time. The
 * turn is the one that placed the prompt `requestId` (a queued prompt runs in
 * a later turn, a steer in the running one), else the session's last.
 */
const summarize = (info: SessionInfo, events: readonly SessionEvent[], requestId?: string) => {
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

/** The session's info and log, read once. */
export const readSession = (rpc: HostRpcClient, sessionId: string) =>
  Effect.all([call(rpc, SessionChannels.get, { sessionId }), call(rpc, SessionChannels.events, { sessionId })], { concurrency: "unbounded" });

const result = (turn: TurnResult, options: Options, streamed: boolean): Output => ({
  json: options.json && streamed ? { type: "result", ...turn } : turn,
  text: formatTurnResult(turn, !streamed),
  compact: options.json && streamed,
  ...(turn.reason === "done" ? {} : { exit: ExitCode.failed }),
});

// ------------------------------------------------------------------ run

/** `lemma run <session|new> <prompt…>`: send a prompt and wait for the turn; `--follow` streams it. */
export const runCommand =
  (target: string, words: readonly string[]): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const turn = turnOptions(options);
      const text = words.join(" ").trim();
      const images = yield* Effect.forEach(options.images, (path) => readImage(io, path));
      if (text === "" && images.length === 0) return yield* usage("run needs a prompt");
      const content: PromptContent = [...(text === "" ? [] : [{ type: "text", text } satisfies TextContent]), ...images];

      const sessionId = target === "new" ? (yield* call(connection.rpc, SessionChannels.create, { cwd: resolve(io.cwd, options.cwd ?? ".") })).id : target;
      if (target === "new" && !options.json) io.err(`lemma: session ${sessionId}`);
      // Always an id: the result and `--follow` are about the turn that places this prompt, which a queue can delay.
      const payload: Prompt = {
        sessionId,
        content,
        requestId: options.requestId ?? randomUUID(),
        ...(Object.keys(turn).length ? { options: turn } : {}),
        ...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
      };
      return yield* send(connection, io, options, payload).pipe(
        // The connection failed with the prompt perhaps placed: the id this command chose is the way back to its turn.
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error._tag !== "RpcClientError" || options.requestId !== undefined || options.json) return;
            io.err(
              `lemma: prompt ${payload.requestId} may be running: \`lemma run ${sessionId} --request-id ${payload.requestId}\` with the same prompt rejoins its turn without placing it twice`,
            );
          }),
        ),
      );
    });

/** Sends the prompt and waits for its turn: shown as it runs with `--follow`, else its result once it ends. */
const send = (connection: Connection, io: Io, options: Options, payload: Prompt) =>
  Effect.gen(function* () {
    const { sessionId } = payload;
    if (options.follow) return yield* followed(connection, io, options, payload);

    // The turn's questions (a tool asking for approval, say) are answered here when there is something to answer
    // with: --answer, --questions, or a terminal. Otherwise the CLI stays unattached, so they go to another client
    // (an open web app) or, with none, fail as unanswerable, which a tool asking for approval takes as a no.
    if (options.answers.length > 0 || options.questions !== undefined || io.ask !== undefined) {
      const rpc = yield* connection.live;
      yield* hostEvents(rpc, yield* questionHandler(rpc, io, options, `session:${sessionId}`));
    }
    yield* prompt(connection.rpc, payload);
    const [info, events] = yield* readSession(connection.rpc, sessionId);
    return result(summarize(info, events, payload.requestId), options, false);
  });

/**
 * `run --follow`: the agent's activity and the session's log are followed
 * from before the prompt is sent, so nothing of its turn is missed, and the
 * turn is shown as they report it (`turnView`). Once the prompt's call has
 * answered, what the log has beyond what was followed shows, read once with
 * what the result reads.
 */
const followed = (connection: Connection, io: Io, options: Options, payload: Prompt) =>
  Effect.gen(function* () {
    const { sessionId, requestId } = payload;
    const rpc = yield* connection.live;
    // Over HTTP: `turnView` asks for it holding `serial`, so neither stream is read meanwhile, and the socket's reader,
    // which reads in order, stalls once one of them fills its buffer: a reply on the socket behind it would never come.
    const view = turnView(io, options, sessionId, requestId, call(connection.rpc, AgentChannels.view, { sessionId }));
    const questions = yield* questionHandler(rpc, io, options, `session:${sessionId}`);
    // One element at a time, whichever stream it comes from, so what is shown stays in order.
    const lock = yield* Semaphore.make(1);
    const serial = <E>(effect: Effect.Effect<void, E>) => lock.withPermits(1)(effect);
    yield* hostEvents(rpc, (event) => (event.type === "notice" ? serial(Effect.sync(() => view.notice(event))) : questions(event)));
    // The output first, so whatever the log then has, the output of what follows it is heard.
    const activity = yield* follow(
      rpc,
      AgentChannels.activity,
      () => undefined,
      (element) => serial(view.activity(element)),
    );
    const log = yield* follow(
      rpc,
      SessionChannels.log,
      () => ({ sessionId, after: view.logSeq() }),
      (update) => serial(view.log(update)),
    );
    yield* Effect.raceFirst(
      prompt(rpc, payload),
      // Either stream failing (not just withdrawn, which reopens it) fails the command.
      Effect.andThen(Effect.raceFirst(Fiber.join(activity), Fiber.join(log)), Effect.never),
    );
    // `turn-ended` may trail the reply (each kind of the agent's output comes in its own order): what came before it too.
    yield* view.ended.pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
    yield* serial(Effect.andThen(Fiber.interrupt(activity), Fiber.interrupt(log)));
    const [info, events] = yield* readSession(connection.rpc, sessionId);
    view.catchUp(events);
    view.close();
    return result(summarize(info, events, requestId), options, options.json || view.streamed());
  });

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
 * withdrawn meanwhile, is caught up from `agent.view`.
 *
 * With `--json`, the activity of the turn and its events in the log print as
 * their channels send them; what the log has of an answer is in its message.
 */
const turnView = (io: Io, options: Options, sessionId: string, requestId: string, viewOf: Effect.Effect<AgentView, Failure>) => {
  const ended = Deferred.makeUnsafe<void>();
  let midLine = false;
  const write = (text: string) => {
    if (text === "") return;
    io.write?.(text);
    midLine = !text.endsWith("\n");
  };
  const line = (text: string) => {
    if (midLine) {
      io.write?.("\n");
      midLine = false;
    }
    io.out(text);
  };
  const json = (value: unknown) => io.out(JSON.stringify(value));

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
        if (options.json) continue;
        streamed = true;
        write(block.text.slice(before?.length ?? 0));
      } else if (block.type === "toolCall" && before === undefined && (final || Object.keys(block.arguments).length > 0)) {
        blocks.set(key, "");
        called.add(block.id);
        if (options.json) continue;
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
    if (options.json) json(element);
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
    if (options.json) return json(fresh);
    let text = "";
    for (const piece of fresh.chunk.split(/(?<=\n)/)) {
      text += `${midLine ? "" : "  "}${piece}`;
      midLine = !piece.endsWith("\n");
    }
    io.write?.(text);
  };

  /** Shows an element of the turn's activity, or skips one that is not of it or was shown: false when the log has not placed it yet. */
  const place = (element: Exclude<AgentActivity, { readonly type: "subscribed" }>): boolean => {
    if (element.sessionId !== sessionId || over || element.type === "queue-changed") return true;
    if (ours === undefined) return false;
    switch (element.type) {
      case "turn-started":
        if (element.turnId === ours && options.json) json(element);
        return true;
      case "turn-ended":
        if (element.turnId !== ours) return true;
        if (options.json) json(element);
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
    if (options.json) json({ type: "appended", event });
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
        } else if (data.message.role === "toolResult" && !options.json) {
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
    notice: (event: Extract<HostEvent, { readonly type: "notice" }>) => (options.json ? json(event) : line(noticeLine(event))),
    activity: (element: AgentActivity): Effect.Effect<void, Failure> =>
      Effect.suspend(() => {
        if (element.type === "subscribed") {
          // Opened again after the agent reloaded: what its turn did meanwhile was missed.
          return activityOpens++ > 0 && ours !== undefined && !over ? rejoin : Effect.void;
        }
        if (place(element)) release();
        else hold(element);
        return Effect.void;
      }),
    log: (update: SessionLogUpdate): Effect.Effect<void, Failure> =>
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
      if (midLine) io.write?.("\n");
      midLine = false;
    },
  };
};
