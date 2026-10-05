import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Deferred, Duration, Effect, Fiber, FiberMap, Stream } from "effect";
import { branchOf, contentText, ThinkingLevel, trajectory } from "@lemma/contracts";
import type {
  AssistantMessage,
  HostEvent,
  ImageContent,
  InteractionAnswer,
  InteractionRequest,
  PromptContent,
  TextContent,
  ThinkingLevel as Thinking,
  TurnOptions,
  UiComposition,
} from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Connection, Io, Options, Output } from "./command.ts";
import { formatCommands, formatModels, formatProviders, formatQueue, formatQuestions, formatTurnResult } from "./format.ts";

/**
 * Commands that act on the host and, with `--follow`, watch it: they
 * subscribe to `Host.Events` over a WebSocket, as the web app does, so they
 * see streamed output and can answer the questions the host asks.
 */

// ------------------------------------------------------------------ questions

const policyOf = (io: Io, options: Options) => options.questions ?? (io.ask === undefined ? "ignore" : "ask");

/** The answer a typed value means for this question, or an error message. */
export const toAnswer = (request: InteractionRequest, raw: string): InteractionAnswer | string => {
  switch (request.type) {
    case "confirm": {
      if (/^(y|yes|true|1)$/i.test(raw.trim())) return { type: "confirm", value: true };
      if (/^(n|no|false|0)$/i.test(raw.trim())) return { type: "confirm", value: false };
      return `Answer yes or no to "${request.title}"`;
    }
    case "ask":
      return { type: "ask", value: raw };
    case "select": {
      const trimmed = raw.trim();
      const option =
        request.options.find((candidate) => candidate.value === trimmed) ??
        request.options.find((candidate) => candidate.label.toLowerCase() === trimmed.toLowerCase()) ??
        (/^\d+$/.test(trimmed) ? request.options[Number(trimmed) - 1] : undefined);
      return option === undefined
        ? `Choose one of: ${request.options.map((candidate, i) => `${i + 1}. ${candidate.value}`).join(", ")}`
        : { type: "select", value: option.value };
    }
  }
};

const promptText = (request: InteractionRequest): string => {
  switch (request.type) {
    case "confirm":
      return `${request.title}${request.detail === undefined ? "" : `\n${request.detail}`} [y/n] `;
    case "ask":
      return `${request.title}${request.placeholder === undefined ? "" : ` (${request.placeholder})`}: `;
    case "select":
      return `${request.title}${request.detail === undefined ? "" : `\n${request.detail}`}\n${request.options.map((option, i) => `  ${i + 1}. ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`).join("\n")}\n> `;
  }
};

/**
 * Handles the host's questions per the policy: the next `--answer`, then the
 * terminal (`ask`), `dismiss`, or `ignore` (leave it to another client, such
 * as an open web app, and say how to answer it from the CLI). Only questions
 * from `origin` are handled, so answers never reach another session's or
 * client's question; `undefined` handles every question (`events --answer`).
 *
 * The handler takes every subscribed event. Each question is answered in its
 * own fiber, so events keep flowing while the terminal waits, and its prompt
 * closes when the question is answered elsewhere or the command ends.
 */
export const questionHandler = (rpc: HostRpcClient, io: Io, options: Options, origin: string | undefined) =>
  Effect.gen(function* () {
    const answers = [...options.answers];
    const seen = new Set<string>();
    const prompts = yield* FiberMap.make<string>();
    const handle = (request: InteractionRequest, next: string | undefined) =>
      Effect.gen(function* () {
        const policy = policyOf(io, options);
        if (next === undefined && policy === "dismiss") {
          yield* rpc.Interaction.Dismiss({ id: request.id }).pipe(Effect.ignore);
          io.err(`lemma: dismissed question "${request.title}"`);
          return;
        }
        if (next === undefined && (policy === "ignore" || io.ask === undefined)) {
          const about = "detail" in request && request.detail !== undefined ? `: ${request.detail}` : "";
          io.err(`lemma: the host asks "${request.title}"${about} (${request.type}); answer with \`lemma answer ${request.id} <value>\` or in the web app`);
          return;
        }
        let raw = next;
        for (;;) {
          // Interrupting the fiber (the question closed, or the command ended) closes the prompt.
          raw ??= yield* Effect.promise((signal) => io.ask!(promptText(request), request.type === "ask" && request.secret === true, signal));
          const answer = toAnswer(request, raw);
          if (typeof answer !== "string") {
            // Someone else may have answered first; that is not an error here.
            yield* rpc.Interaction.Answer({ id: request.id, answer }).pipe(Effect.ignore);
            return;
          }
          io.err(`lemma: ${answer}`);
          if (io.ask === undefined) return;
          raw = undefined;
        }
      });
    return (event: HostEvent): Effect.Effect<void> => {
      if (event.type === "interaction-closed") return FiberMap.remove(prompts, event.id);
      if (event.type !== "interaction") return Effect.void;
      const request = event.request;
      if (seen.has(request.id) || (origin !== undefined && request.origin !== origin)) return Effect.void;
      seen.add(request.id);
      // `--answer` values go to questions in the order they arrive.
      return Effect.asVoid(FiberMap.run(prompts, request.id, handle(request, answers.shift())));
    };
  });

/**
 * Subscribes to host events, then confirms the subscription with a call on
 * the same socket (calls on one socket are handled in order), so nothing the
 * command causes next is missed.
 */
export const subscribe = (rpc: HostRpcClient, onEvent: (event: HostEvent) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fiber = yield* rpc.Host.Events().pipe(
      Stream.runForEach((event) => onEvent(event).pipe(Effect.catchAllCause(() => Effect.void))),
      Effect.forkScoped,
    );
    yield* rpc.Host.Info();
    return fiber;
  });

export const noticeLine = (event: Extract<HostEvent, { type: "notice" }>) => {
  const notice = event.notice;
  const links = notice.links?.map((link) => ` ${link.label === undefined ? link.url : `${link.label}: ${link.url}`}`).join("") ?? "";
  return `[${notice.level}]${notice.source === undefined ? "" : ` ${notice.source}:`} ${notice.message}${notice.code === undefined ? "" : ` (code: ${notice.code})`}${links}`;
};

// ------------------------------------------------------------------ run / cancel

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

const turnOptions = (options: Options): TurnOptions | CliError => {
  if (options.thinking !== undefined && !(ThinkingLevel.literals as readonly string[]).includes(options.thinking)) {
    return usage(`--thinking must be one of ${ThinkingLevel.literals.join(", ")}`);
  }
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking as Thinking }),
  };
};

/**
 * How a turn ended, from the log: the reply, the reason, usage, and time. The
 * turn is the one that placed the prompt `requestId` (a queued prompt runs in
 * a later turn, a steer in the running one), else the session's last.
 */
const turnOf = (rpc: HostRpcClient, sessionId: string, requestId?: string) =>
  Effect.gen(function* () {
    const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId }), rpc.Session.Events({ sessionId })], { concurrency: "unbounded" });
    const placed = events.find((event) => event.data.type === "message" && event.data.requestId !== undefined && event.data.requestId === requestId);
    const turnId = placed?.data.type === "message" ? placed.data.turnId : undefined;
    // On that turn's own branch, through its last event: a checkout since may have left it off the session's.
    const last = turnId === undefined ? undefined : events.filter((event) => "turnId" in event.data && event.data.turnId === turnId).at(-1);
    const turns = trajectory(branchOf(events, last?.id ?? info.leaf));
    const turn = turnId === undefined ? turns.at(-1) : turns.find((candidate) => candidate.turnId === turnId);
    const response = turn?.steps.filter((step) => step.response !== undefined).at(-1)?.response;
    return {
      session: sessionId,
      turn: turn?.turnId,
      reason: turn?.end?.reason ?? "running",
      ...(turn?.end?.error === undefined ? {} : { error: turn.end.error }),
      steps: turn?.steps.length ?? 0,
      toolCalls: turn?.steps.reduce((sum, step) => sum + step.tools.length, 0) ?? 0,
      usage: turn?.usage,
      duration: turn?.endedAt === undefined ? undefined : turn.endedAt - turn.startedAt,
      text: response === undefined ? "" : contentText(response.message.content),
    };
  });
export type TurnResult = Effect.Effect.Success<ReturnType<typeof turnOf>>;

/** `lemma run <session|new> <prompt…>`: send a prompt and wait for the turn; `--follow` streams it. */
export const runCommand =
  (target: string, words: readonly string[]): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const turn = turnOptions(options);
      if (turn instanceof CliError) return yield* turn;
      const text = words.join(" ").trim();
      const images = yield* Effect.forEach(options.images, (path) => readImage(io, path));
      if (text === "" && images.length === 0) return yield* usage("run needs a prompt");
      const content: PromptContent = [...(text === "" ? [] : [{ type: "text", text } satisfies TextContent]), ...images];

      const sessionId = target === "new" ? (yield* connection.rpc.Session.Create({ cwd: resolve(io.cwd, options.cwd ?? ".") })).id : target;
      if (target === "new" && !options.json) io.err(`lemma: session ${sessionId}`);
      // Always an id: the result and `--follow` are about the turn that places this prompt, which a queue can delay.
      const requestId = options.requestId ?? randomUUID();
      const payload = {
        sessionId,
        content,
        requestId,
        ...(Object.keys(turn).length ? { options: turn } : {}),
        ...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
      };

      if (!options.follow) {
        // The turn's questions (a tool asking for approval, say) are answered here when there is something to answer
        // with: --answer, --questions, or a terminal. Otherwise the CLI stays unattached, so they go to another client
        // (an open web app) or, with none, fail as unanswerable, which a tool asking for approval takes as a no.
        if (options.answers.length > 0 || options.questions !== undefined || io.ask !== undefined) {
          const rpc = yield* connection.live;
          yield* subscribe(rpc, yield* questionHandler(rpc, io, options, `session:${sessionId}`));
        }
        yield* connection.rpc.Agent.Prompt(payload);
        return result(yield* turnOf(connection.rpc, sessionId, requestId), options, false);
      }

      const ended = yield* Deferred.make<void>();
      let midLine = false;
      const line = (text: string) => {
        if (midLine) {
          io.write?.("\n");
          midLine = false;
        }
        io.out(text);
      };
      const rpc = yield* connection.live;
      const questions = yield* questionHandler(rpc, io, options, `session:${sessionId}`);
      /**
       * The turn that placed the prompt: only that turn is streamed. It is
       * known once its message is logged, or, for a retry (the request id was
       * placed before), from the log. Until then, and while a retry joins the
       * turn, the session's events are held, since its `turn-started` comes
       * first.
       */
      let ours: string | undefined;
      let joining = false;
      let held: HostEvent[] = [];
      /** Text or tool calls of ours were shown: without any (a turn that had ended), the result prints its answer. */
      let streamed = false;
      /**
       * What a retry joining a running turn showed already, so the events
       * after it skip it: log events through `logSeq`, the steps it printed
       * whole, the call in flight through its event `seq`, and how much of
       * each running tool's output.
       */
      let logSeq = 0;
      const whole = new Set<string>();
      let joined: { readonly stepId: string; readonly seq: number } | undefined;
      const printed = new Map<string, number>();
      const turnOfEvent = (event: HostEvent): string | undefined => {
        if (event.type === "delta" || event.type === "turn-started" || event.type === "turn-ended") return event.turnId;
        if (event.type === "session-appended") return "turnId" in event.event.data ? event.event.data.turnId : undefined;
        // Tool output carries no turn; a session runs one turn at a time, and it is ours once we have one.
        return ours;
      };
      const print = (event: HostEvent) =>
        Effect.gen(function* () {
          if (event.type === "delta" && (event.event.type === "text-delta" || event.event.type === "toolcall-end")) streamed = true;
          if (options.json) io.out(JSON.stringify(event));
          else if (event.type === "delta" && event.event.type === "text-delta") {
            io.write?.(event.event.delta);
            midLine = !event.event.delta.endsWith("\n");
          } else if (event.type === "delta" && event.event.type === "toolcall-end")
            line(`→ ${event.event.toolCall.name} ${JSON.stringify(event.event.toolCall.arguments)}`);
          else if (event.type === "tool-output") {
            // Indented under its `→` line, as it arrives; partial lines continue where they stopped.
            let text = "";
            for (const piece of event.chunk.split(/(?<=\n)/)) {
              text += `${midLine ? "" : "  "}${piece}`;
              midLine = !piece.endsWith("\n");
            }
            io.write?.(text);
          } else if (event.type === "delta" && event.event.type === "error") line(`✕ ${event.event.message.errorMessage ?? event.event.message.stopReason}`);
          else if (event.type === "session-appended" && event.event.data.type === "message" && event.event.data.message.role === "toolResult") {
            const message = event.event.data.message;
            const timing = event.event.data.timing;
            const first = contentText(message.content).trim().split("\n")[0] ?? "";
            line(
              `← ${message.toolName} ${message.isError ? "error" : "ok"}${timing === undefined ? "" : ` ${timing.endedAt - timing.startedAt}ms`}${first ? `: ${first.slice(0, 120)}` : ""}`,
            );
          }
          if (event.type === "turn-ended") yield* Deferred.succeed(ended, undefined);
        });
      /** Shows an event of ours, skipping what a retry's join showed already. */
      const show = (event: HostEvent) => {
        if (event.type === "session-appended" && event.event.seq <= logSeq) return Effect.void;
        if (event.type === "delta" && whole.has(event.stepId)) return Effect.void;
        if (event.type === "delta" && event.stepId === joined?.stepId && event.seq !== undefined && event.seq <= joined.seq) return Effect.void;
        if (event.type === "tool-output" && event.offset !== undefined) {
          const seen = printed.get(event.toolCallId) ?? 0;
          if (event.offset + event.chunk.length <= seen) return Effect.void;
          printed.set(event.toolCallId, event.offset + event.chunk.length);
          if (event.offset < seen) return print({ ...event, chunk: event.chunk.slice(seen - event.offset), offset: seen });
        }
        return print(event);
      };
      /** A model answer's text and tool calls, shown as if streamed. */
      const answer = (turnId: string, stepId: string, content: AssistantMessage["content"]) =>
        Effect.forEach(
          content,
          (block, index) =>
            block.type === "text"
              ? print({ type: "delta", sessionId, turnId, stepId, event: { type: "text-delta", index, delta: block.text } })
              : block.type === "toolCall" && Object.keys(block.arguments).length > 0
                ? print({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-end", index, toolCall: block } })
                : Effect.void,
          { discard: true },
        );
      // One event at a time, so a retry's join and the events after it show in order.
      const lock = yield* Effect.makeSemaphore(1);
      yield* subscribe(rpc, (event) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (event.type === "interaction" || event.type === "interaction-closed") return yield* questions(event);
            if (event.type === "notice") return options.json ? io.out(JSON.stringify(event)) : line(noticeLine(event));
            if (!("sessionId" in event) || event.sessionId !== sessionId) return;
            if (ours !== undefined && !joining) return turnOfEvent(event) === ours ? yield* show(event) : undefined;
            if (!joining && event.type === "session-appended" && event.event.data.type === "message" && event.event.data.requestId === requestId) {
              ours = event.event.data.turnId;
              // What was held: this turn's own events (its start); tool output from before was another turn's.
              const replay = held.filter((earlier) => earlier.type !== "tool-output" && turnOfEvent(earlier) === ours);
              held = [];
              for (const earlier of replay) yield* show(earlier);
              return yield* show(event);
            }
            held = [...held.slice(-1023), event];
          }),
        ),
      );

      // A retry: the request id was placed before, so no message of it is coming. Follow the turn that placed it, from
      // what it has done so far: subscribed first, every event from here is held until that is shown.
      joining = true;
      const log = yield* connection.rpc.Session.Events({ sessionId });
      const placed = log.find((event) => event.data.type === "message" && event.data.requestId === requestId);
      const turnId = placed?.data.type === "message" ? placed.data.turnId : undefined;
      if (turnId === undefined) {
        joining = false;
      } else if (log.some((event) => event.data.type === "turn-end" && event.data.turnId === turnId)) {
        // Over: nothing more comes, and the result prints its answer.
        ours = turnId;
        joining = false;
        held = [];
        yield* Deferred.succeed(ended, undefined);
      } else {
        const view = yield* connection.rpc.Agent.View({ sessionId });
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            ours = turnId;
            // What it has logged: its answers' text and tool calls, and the tools' results.
            for (const event of log) {
              const data = event.data;
              if (data.type !== "message" || data.turnId !== turnId || data.message.role === "user") continue;
              if (data.message.role === "assistant") {
                if (data.stepId !== undefined) whole.add(data.stepId);
                yield* answer(turnId, data.stepId ?? "", data.message.content);
              } else yield* print({ type: "session-appended", sessionId, event });
            }
            logSeq = log.at(-1)?.seq ?? 0;
            // A step that ended while joining, after the log was read, shows whole when its answer comes (below).
            const endedSince = new Set(
              held.flatMap((event) =>
                event.type === "session-appended" &&
                event.event.seq > logSeq &&
                event.event.data.type === "message" &&
                event.event.data.message.role === "assistant"
                  ? [event.event.data.stepId ?? ""]
                  : [],
              ),
            );
            // The call in flight and running tools' output, as the agent had them.
            if (view.turnId === turnId && view.draft !== undefined && !endedSince.has(view.draft.stepId)) {
              joined = { stepId: view.draft.stepId, seq: view.draft.seq };
              yield* answer(
                turnId,
                view.draft.stepId,
                view.draft.blocks.map((entry) => entry.block),
              );
            }
            if (view.turnId === turnId) {
              for (const entry of view.output) {
                yield* show({ type: "tool-output", sessionId, toolCallId: entry.toolCallId, chunk: entry.output, offset: entry.length - entry.output.length });
              }
            }
            for (const stepId of endedSince) if (stepId !== joined?.stepId) whole.add(stepId);
            const replay = held;
            held = [];
            joining = false;
            for (const event of replay) {
              if (turnOfEvent(event) !== turnId) continue;
              const data = event.type === "session-appended" ? event.event.data : undefined;
              if (event.type === "session-appended" && data?.type === "message" && data.message.role === "assistant" && endedSince.has(data.stepId ?? "")) {
                if (data.stepId !== joined?.stepId && event.event.seq > logSeq) yield* answer(turnId, data.stepId ?? "", data.message.content);
                continue;
              }
              yield* show(event);
            }
          }),
        );
      }
      yield* rpc.Agent.Prompt(payload);
      // `turn-ended` may trail the reply; the log is authoritative either way.
      yield* Deferred.await(ended).pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
      if (midLine) io.write?.("\n");
      return result(yield* turnOf(connection.rpc, sessionId, requestId), options, options.json || streamed);
    });

const result = (turn: TurnResult, options: Options, streamed: boolean): Output => ({
  json: options.json && streamed ? { type: "result", ...turn } : turn,
  text: formatTurnResult(turn, !streamed),
  compact: options.json && streamed,
  ...(turn.reason === "done" ? {} : { exit: ExitCode.failed }),
});

export const cancelCommand =
  (sessionId: string): Command =>
  ({ rpc }) =>
    Effect.as(rpc.Agent.Cancel({ sessionId }), { json: { cancelled: sessionId }, text: `cancelled any running turn in ${sessionId}` });

/** `lemma queue <session>`: prompts waiting for a turn. */
export const queueCommand =
  (sessionId: string): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      yield* rpc.Session.Get({ sessionId });
      const queue = yield* rpc.Agent.Queue({ sessionId });
      return { json: queue, text: formatQueue(queue) };
    });

/** `lemma withdraw <session> <request>`: takes a prompt out of the queue. */
export const withdrawCommand =
  (sessionId: string, requestId: string): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      if (!(yield* rpc.Agent.Withdraw({ sessionId, requestId }))) {
        return yield* new CliError({
          code: "NotFound",
          message: `No queued prompt ${requestId} in ${sessionId}: a turn may have placed it already`,
          subject: requestId,
          exit: ExitCode.failed,
        });
      }
      return { json: { withdrawn: requestId }, text: `withdrew ${requestId}` };
    });

// ------------------------------------------------------------------ events / questions

/** `lemma events`: follow everything the host publishes (optionally one session's), as the web app sees it. */
export const eventsCommand: Command = (connection, io, options) =>
  Effect.gen(function* () {
    const rpc = yield* connection.live;
    const questions = yield* questionHandler(rpc, io, options, options.session === undefined ? undefined : `session:${options.session}`);
    const fiber = yield* subscribe(rpc, (event) =>
      Effect.gen(function* () {
        if (options.session !== undefined && "sessionId" in event && event.sessionId !== options.session) return;
        if (options.json) io.out(JSON.stringify(event));
        else io.out(eventLine(event));
        // Watching never answers unless asked to.
        if (options.questions !== undefined) yield* questions(event);
      }),
    );
    yield* Fiber.join(fiber).pipe(Effect.ignore);
    return undefined;
  });

const eventLine = (event: HostEvent): string => {
  switch (event.type) {
    case "notice":
      return noticeLine(event);
    case "delta":
      return `${event.sessionId} delta ${event.event.type}${event.event.type === "text-delta" ? ` ${JSON.stringify(event.event.delta)}` : ""}`;
    case "tool-output":
      return `${event.sessionId} tool output ${event.toolCallId} ${JSON.stringify(event.chunk)}`;
    case "session-appended":
      return `${event.sessionId} appended #${event.event.seq} ${event.event.data.type}`;
    case "session-changed":
      return `${event.info.id} changed${event.info.title === undefined ? "" : ` "${event.info.title}"`}`;
    case "session-removed":
      return `${event.sessionId} deleted`;
    case "turn-started":
      return `${event.sessionId} turn started ${event.turnId}`;
    case "turn-ended":
      return `${event.sessionId} turn ended ${event.turnId} (${event.reason})`;
    case "queue-changed":
      return `${event.sessionId} queue ${event.queue.length === 0 ? "empty" : event.queue.map((queued) => `${queued.mode} ${queued.requestId}`).join(", ")}`;
    case "interaction":
      return `question ${event.request.id} (${event.request.type}): ${event.request.title}`;
    case "interaction-closed":
      return `question ${event.id} closed`;
    case "plugins-changed":
      return `plugins: ${event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ")}`;
    case "commands-changed":
      return `commands: ${event.commands.map((command) => command.id).join(" ")}`;
    case "models-changed":
      return "models changed";
    case "ui-changed":
      return uiLine(event.ui);
    case "mcp-changed":
      return `mcp: ${event.servers.length ? event.servers.map((server) => `${server.id}=${server.status}`).join(" ") : "no servers"}`;
  }
};

const uiLine = (ui: UiComposition): string => {
  const rows = Object.entries(ui.plugins).map(([id, row]) => `${id}${row.enabled === false ? "=off" : ""}${row.config === undefined ? "" : "+config"}`);
  return `ui: ${rows.length ? rows.join(" ") : "no rows"}; files ${ui.files.length ? ui.files.map((file) => `${file.source}/${file.name}`).join(" ") : "none"}`;
};

/** Open questions: the host replays them to every new subscriber. */
const openQuestions = (connection: Connection) =>
  Effect.gen(function* () {
    const found = new Map<string, InteractionRequest>();
    const fiber = yield* subscribe(yield* connection.live, (event) =>
      Effect.sync(() => {
        if (event.type === "interaction") found.set(event.request.id, event.request);
        if (event.type === "interaction-closed") found.delete(event.id);
      }),
    );
    // Replays arrive right after subscribing; give them a moment.
    yield* Effect.sleep(Duration.millis(300));
    yield* Fiber.interrupt(fiber);
    return [...found.values()];
  });

export const questionsCommand: Command = (connection) =>
  Effect.map(openQuestions(connection), (questions) => ({ json: questions, text: formatQuestions(questions) }));

export const answerCommand =
  (id: string, words: readonly string[]): Command =>
  (connection) =>
    Effect.gen(function* () {
      const request = (yield* openQuestions(connection)).find((candidate) => candidate.id === id);
      if (request === undefined) return yield* new CliError({ code: "NotFound", message: `No open question ${id}`, subject: id, exit: ExitCode.failed });
      const answer = toAnswer(request, words.join(" "));
      if (typeof answer === "string") return yield* usage(answer);
      yield* connection.rpc.Interaction.Answer({ id, answer });
      return { json: { answered: id, answer }, text: `answered "${request.title}"` };
    });

export const dismissCommand =
  (id: string): Command =>
  ({ rpc }) =>
    Effect.as(rpc.Interaction.Dismiss({ id }), { json: { dismissed: id }, text: `dismissed ${id}` });

// ------------------------------------------------------------------ providers and models

export const modelsCommand: Command = ({ rpc }, _io, options) =>
  Effect.map(rpc.Llm.Models(options.all ? {} : { available: true }), (models) => ({ json: models, text: formatModels(models) }));

export const providersCommand: Command = ({ rpc }) => Effect.map(rpc.Llm.Providers(), (providers) => ({ json: providers, text: formatProviders(providers) }));

/** `lemma login <provider>`: runs the provider's login, answering its questions per the policy and printing its notices. */
export const loginCommand =
  (provider: string): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const info = (yield* connection.rpc.Llm.Providers()).find((candidate) => candidate.id === provider);
      if (info === undefined)
        return yield* new CliError({ code: "UnknownProvider", message: `No provider "${provider}"`, subject: provider, exit: ExitCode.failed });
      const method = options.method ?? info.auth[0]?.type;
      if (method !== "api_key" && method !== "oauth") return yield* usage(`--method must be one of ${info.auth.map((auth) => auth.type).join(", ")}`);
      if (!info.auth.some((auth) => auth.type === method))
        return yield* usage(`${provider} does not offer ${method}; it offers ${info.auth.map((auth) => auth.type).join(", ")}`);
      const rpc = yield* connection.live;
      const questions = yield* questionHandler(rpc, io, options, `login:${provider}`);
      yield* subscribe(rpc, (event) =>
        Effect.gen(function* () {
          if (event.type === "notice") io.err(noticeLine(event));
          yield* questions(event);
        }),
      );
      yield* rpc.Llm.Login({ provider, type: method });
      return { json: { loggedIn: provider, method }, text: `logged in to ${info.name}` };
    });

export const logoutCommand =
  (provider: string): Command =>
  ({ rpc }) =>
    Effect.as(rpc.Llm.Logout({ provider }), { json: { loggedOut: provider }, text: `logged out of ${provider}` });

/** `lemma do`: lists the commands plugins registered; `lemma do <id>` runs one, answering its questions per the policy. */
export const listCommandsCommand: Command = ({ rpc }) => Effect.map(rpc.Command.List(), (commands) => ({ json: commands, text: formatCommands(commands) }));

export const doCommand =
  (id: string): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const rpc = yield* connection.live;
      const origin = `command:${randomUUID()}`;
      const questions = yield* questionHandler(rpc, io, options, origin);
      yield* subscribe(rpc, (event) =>
        Effect.gen(function* () {
          if (event.type === "notice") io.err(noticeLine(event));
          yield* questions(event);
        }),
      );
      const cwd = resolve(io.cwd, options.cwd ?? ".");
      const result = yield* rpc.Command.Run({ id, cwd, origin, ...(options.session === undefined ? {} : { sessionId: options.session }) });
      return { json: { command: id, ...result }, text: result.message ?? `${id}: done` };
    });
