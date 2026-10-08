import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Deferred, Duration, Effect, FiberMap, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { AgentChannels, CommandChannels, HostError, LlmChannels, SessionChannels } from "@lemma/contracts";
import type {
  AgentActivity,
  ChannelDeclaration,
  InteractionAnswer,
  InteractionRequest,
  LlmChange,
  NoticePayload,
  RuntimeEvent,
  SessionLogUpdate,
  SessionsChange,
  UiComposition,
} from "@lemma/contracts";
import { dropped } from "@lemma/client";
import type { Host } from "@lemma/client";
import { call, callOn, connectedAfter, following, ofChannel, received, reconnecting } from "./channels.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Connection, Failure, Io, Options } from "./command.ts";
import { formatCommands, formatModels, formatProviders, formatQueue, formatQuestions } from "./format.ts";

/**
 * Commands that act on the host and watch it: they hear the host's own events
 * over `@lemma/client`'s `Host`, as the web app does, to answer the questions
 * it asks and show its notices, and follow its subsystems' streams.
 */

// ------------------------------------------------------------------ questions

const policyOf = (io: Io, options: Options) => options.questions ?? (io.ask === undefined ? "ignore" : "ask");

/**
 * Whether a command answers the host's questions, so the host holds them for
 * it: if and only if it can, having answers to give (`--answer`), dismissing
 * them, or asking at a terminal it has. Otherwise (`ignore`, or `ask` with no
 * terminal) it leaves them to another client that answers, or with none, the
 * question fails as unanswerable, which a tool asking for approval takes as
 * a no. It is decided once, as the command connects: once its `--answer`
 * values run out, it still holds the questions it then ignores.
 */
export const answering = (io: Io, options: Options): boolean => {
  const policy = policyOf(io, options);
  return options.answers.length > 0 || policy === "dismiss" || (policy === "ask" && io.ask !== undefined);
};

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

/** How a command words its questions at the terminal, beyond their titles. */
interface QuestionView {
  /** Runs before a question is asked at the terminal: to wait for what explains it. */
  readonly before?: (request: InteractionRequest) => Effect.Effect<void>;
  /** The prompt for a question, when the command says it better than the question's title. */
  readonly prompt?: (request: InteractionRequest) => string | undefined;
  /** What to say when a question waiting at the terminal closes without an answer from it; "" says nothing. */
  readonly closed?: (request: InteractionRequest) => string;
}

/**
 * Handles the host's questions per the policy: the next `--answer`, then the
 * terminal (`ask`), `dismiss`, or `ignore` (leave it to another client, such
 * as an open web app, and say how to answer it from the CLI: the command
 * holds no question then, see `answering`). Only questions
 * from `origin` are handled, so answers never reach another session's or
 * client's question; `undefined` handles every question (`events --answer`).
 *
 * The handler takes every event the command hears (`hearing`), in order. An
 * `--answer` is sent before the next event is handled, so the values go to
 * questions in the order they arrive, and one is used up only once the host
 * takes it: one that reached a question already closed (`NotFound`: answered
 * elsewhere or withdrawn, as a question the host sends on connecting may be
 * by the time it is handled) goes to the next question. Any other question
 * is handled in its own fiber, so events keep flowing while the terminal
 * waits, and its prompt closes when the question is answered elsewhere or the
 * command ends. The host sends the questions still open to every client that
 * subscribes, so those open as the command connects reach the person. A
 * dropped connection loses the events meanwhile, so one asked during the
 * drop (a tool's approval) reaches them once the connection is back, as it
 * subscribes anew; the prompt of one that closed meanwhile closes then,
 * as `Interaction.List` no longer has it; and an answer given while it was
 * down goes once it is back.
 */
export const questionHandler = (host: Host, io: Io, options: Options, origin: string | undefined, view: QuestionView = {}) =>
  Effect.gen(function* () {
    const answers = [...options.answers];
    const seen = new Set<string>();
    const prompts = yield* FiberMap.make<string>();
    /** Questions waiting at the terminal now. */
    const prompting = new Map<string, InteractionRequest>();
    /**
     * Sends an answer or a dismissal, again on the next connection when the
     * connection dropped first: the first answer wins, so a second is safe.
     * Says whether the question was still open: the host refuses it
     * `NotFound` once it closed (answered elsewhere, or withdrawn). Any other
     * refusal is not this command's concern.
     */
    const reply = (send: () => Promise<void>): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const { generation } = host.status();
        return Effect.tryPromise({ try: send, catch: (error) => error }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            dropped(error)
              ? Effect.andThen(connectedAfter(host, generation), reply(send))
              : Effect.succeed(!(error instanceof HostError && error.code === "NotFound")),
          ),
        );
      });
    const handle = (request: InteractionRequest, next: string | undefined) =>
      Effect.gen(function* () {
        const policy = policyOf(io, options);
        if (next === undefined && policy === "dismiss") {
          yield* reply(() => host.interaction.dismiss(request.id));
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
          if (raw === undefined) {
            if (view.before !== undefined) yield* view.before(request);
            prompting.set(request.id, request);
            raw = yield* Effect.promise((signal) =>
              io.ask!(view.prompt?.(request) ?? promptText(request), request.type === "ask" && request.secret === true, signal),
            ).pipe(Effect.ensuring(Effect.sync(() => prompting.delete(request.id))));
          }
          const answer = toAnswer(request, raw);
          if (typeof answer !== "string") {
            yield* reply(() => host.interaction.answer(request.id, answer));
            return;
          }
          io.err(`lemma: ${answer}`);
          if (io.ask === undefined) return;
          raw = undefined;
        }
      });
    const handler = (event: RuntimeEvent): Effect.Effect<void> => {
      if (event.type === "interaction-closed") {
        const asking = prompting.get(event.id);
        return FiberMap.remove(prompts, event.id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const said = asking === undefined ? undefined : (view.closed?.(asking) ?? "(answered elsewhere)");
              if (said !== undefined && said !== "") io.err(said);
            }),
          ),
        );
      }
      if (event.type !== "interaction") return Effect.void;
      const request = event.request;
      if (seen.has(request.id) || (origin !== undefined && request.origin !== origin)) return Effect.void;
      seen.add(request.id);
      const next = answers.shift();
      const answer = next === undefined ? undefined : toAnswer(request, next);
      // With no `--answer` left, the policy has it; with one that does not answer it, `handle` says so and asks at a terminal.
      if (next === undefined || answer === undefined || typeof answer === "string")
        return Effect.asVoid(FiberMap.run(prompts, request.id, handle(request, next)));
      // Sent before the next event is handled, so `--answer` values go to questions in the order they arrive, and one that
      // reached a question already closed goes back for the next.
      return Effect.map(
        reply(() => host.interaction.answer(request.id, answer)),
        (open) => {
          if (!open) answers.unshift(next);
        },
      );
    };
    /** Those waiting at the terminal that closed while the connection was down: their `interaction-closed` was lost with it. */
    const catchUp = Effect.gen(function* () {
      const asking = [...prompting.keys()];
      const waiting = yield* Effect.promise(() => host.interaction.list().catch(() => undefined));
      // Dropped again: the next connection catches up.
      if (waiting === undefined) return;
      for (const id of asking) if (!waiting.some((request) => request.id === id)) yield* handler({ type: "interaction-closed", id });
    });
    let generation = host.status().generation;
    const reconnected = yield* received<void>((onElement) =>
      host.onStatus((status) => {
        if (status.state !== "connected" || status.generation === generation) return;
        generation = status.generation;
        onElement(undefined);
      }),
    );
    yield* Effect.forkScoped(Stream.runForEach(reconnected, () => catchUp));
    return handler;
  });

/**
 * `connection.host` for a command that hears the host's own events, with
 * them in the command's own queue (`events`, which `hostEvents` reads),
 * unbounded as `received`'s is, so the connection never waits on the
 * command. The queue is made before the command connects and fed from the
 * first subscription on (`ConnectOptions.onEvent`): a subscription starts
 * with the questions still open, which can come before the connection is
 * confirmed and `connection.host` returns.
 */
export const hearing = (
  connection: Connection,
  answers: boolean,
): Effect.Effect<{ readonly host: Host; readonly events: Stream.Stream<RuntimeEvent> }, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<RuntimeEvent>();
    const host = yield* connection.host({ answers, onEvent: (event) => void Queue.offerUnsafe(events, event) });
    return { host, events: Stream.fromQueue(events) };
  });

/**
 * Handles the host's own events a command hears (`hearing`), for as long as
 * the scope lasts, from its first subscription's start. What the command
 * causes next is among them (a question it asks): its connection is
 * confirmed, so its subscription has joined. `onEvent` takes them in order,
 * so it may wait (on a lock, a prompt) while the queue holds the rest. A
 * handler's failure is its event's alone.
 */
export const hostEvents = (
  events: Stream.Stream<RuntimeEvent>,
  onEvent: (event: RuntimeEvent) => Effect.Effect<void, Failure>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(Effect.forkScoped(Stream.runForEach(events, (event) => onEvent(event).pipe(Effect.catchCause(() => Effect.void)))));

export const noticeLine = (event: Extract<RuntimeEvent, { type: "notice" }>) => {
  const notice = event.notice;
  const links = notice.links?.map((link) => ` ${link.label === undefined ? link.url : `${link.label}: ${link.url}`}`).join("") ?? "";
  return `[${notice.level}]${notice.source === undefined ? "" : ` ${notice.source}:`} ${notice.message}${notice.code === undefined ? "" : ` (code: ${notice.code})`}${links}`;
};

// ------------------------------------------------------------------ cancel / queue

export const cancelCommand =
  (sessionId: string): Command =>
  ({ rpc }) =>
    Effect.as(call(rpc, AgentChannels.cancel, { sessionId }), { json: { cancelled: sessionId }, text: `cancelled any running turn in ${sessionId}` });

/** `lemma queue <session>`: prompts waiting for a turn. */
export const queueCommand =
  (sessionId: string): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      yield* call(rpc, SessionChannels.get, { sessionId });
      const queue = yield* call(rpc, AgentChannels.queue, { sessionId });
      return { json: queue, text: formatQueue(queue) };
    });

/** `lemma withdraw <session> <request>`: takes a prompt out of the queue. */
export const withdrawCommand =
  (sessionId: string, requestId: string): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      if (!(yield* call(rpc, AgentChannels.withdraw, { sessionId, requestId }))) {
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

/**
 * `lemma events`: what the host publishes, as it happens. Its own events
 * (`RuntimeEvent`: notices, questions, and plugin, channel, and UI changes),
 * and the bundled subsystems' streams: `agent.activity`, `sessions.changes`,
 * `llm.changes`, and `commands.changes`. `--session <id>` keeps only that
 * session's elements of the first two, and adds its log from now
 * (`sessions.log`). A stream that is not served, or that its plugin's reload
 * withdrew, is followed again once it is served (`follow` in
 * `@lemma/client`). A dropped connection is reconnected (`reconnecting`):
 * each stream opens again, saying `subscribed` anew, and the log goes on
 * from the last event printed; the host's own events while it was down are
 * lost. With `--json`, each line is `{"from", "element"}`: `from` is `host`
 * for the host's own events, else the channel.
 */
export const eventsCommand: Command = (connection, io, options) =>
  Effect.gen(function* () {
    // Watching never answers unless asked to.
    const { host, events } = yield* hearing(connection, options.questions !== undefined && answering(io, options));
    return yield* reconnecting(host, io, watch(host, events, io, options));
  });

const watch = (host: Host, events: Stream.Stream<RuntimeEvent>, io: Io, options: Options) =>
  Effect.gen(function* () {
    const session = options.session;
    // A session's log from now: what it has already, `lemma session show` prints.
    let after = session === undefined ? 0 : (yield* callOn(host, SessionChannels.get, { sessionId: session })).lastSeq;
    const ofSession = (sessionId: string) => session === undefined || sessionId === session;
    const print = (from: string, element: unknown, text: string | undefined) => {
      if (options.json) io.out(JSON.stringify({ from, element }));
      else if (text !== undefined) io.out(text);
    };
    const note = (text: string) => {
      if (!options.json) io.out(text);
    };
    const questions =
      options.questions === undefined ? undefined : yield* questionHandler(host, io, options, session === undefined ? undefined : `session:${session}`);
    yield* hostEvents(events, (event) => {
      // What the subsystems report, their own streams carry; the host's stream is followed for its own events.
      print("host", event, hostLine(event));
      return questions === undefined ? Effect.void : questions(event);
    });
    /** Follows `channel` while the command runs, again once it is served when it was not, its plugin withdrew it, or the connection dropped; any other ending stops it. */
    const keep = <Payload, Success>(channel: ChannelDeclaration<"stream", Payload, Success>, payload: () => Payload, show: (element: Success) => void) =>
      following(host, channel, payload, show, (error) => {
        // Said once for every stream (`reconnecting`), and opened again on the next connection.
        if (dropped(error)) return true;
        if (ofChannel(error, channel.id, "Withdrawn")) note(`${channel.id} withdrawn: its plugin stopped or reloaded; following it again`);
        else if (ofChannel(error, channel.id, "NotFound")) note(`${channel.id} not served: following it once it is`);
        else {
          note(error === undefined ? `${channel.id} ended` : `${channel.id} ended: ${error.message}`);
          return false;
        }
        return true;
      });
    yield* keep(
      AgentChannels.activity,
      () => undefined,
      (element) => {
        if (element.type === "subscribed" || ofSession(element.sessionId)) print(AgentChannels.activity.id, element, activityLine(element));
      },
    );
    yield* keep(
      SessionChannels.changes,
      () => undefined,
      (element) => {
        if (element.type === "subscribed" || ofSession(element.type === "session-changed" ? element.info.id : element.sessionId))
          print(SessionChannels.changes.id, element, sessionsLine(element));
      },
    );
    yield* keep(
      LlmChannels.changes,
      () => undefined,
      (element) => print(LlmChannels.changes.id, element, llmLine(element)),
    );
    yield* keep(
      CommandChannels.changes,
      () => undefined,
      (element) => print(CommandChannels.changes.id, element, `commands: ${element.map((command) => command.id).join(" ")}`),
    );
    if (session !== undefined) {
      yield* keep(
        SessionChannels.log,
        () => ({ sessionId: session, after }),
        (update) => {
          after = update.type === "appended" ? update.event.seq : (update.events.at(-1)?.seq ?? after);
          print(SessionChannels.log.id, update, logLines(session, update));
        },
      );
    }
    // Until interrupted, or the connection is given up on.
    return yield* Effect.never;
  });

/** One of the host's own events as a line. */
const hostLine = (event: RuntimeEvent): string => {
  switch (event.type) {
    case "notice":
      return noticeLine(event);
    case "interaction":
      return `question ${event.request.id} (${event.request.type}): ${event.request.title}`;
    case "interaction-closed":
      return `question ${event.id} closed`;
    case "plugins-changed":
      return `plugins: ${event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ")}`;
    case "channels-changed":
      return `channels: ${event.channels.map((channel) => channel.id).join(" ")}`;
    case "ui-changed":
      return uiLine(event.ui);
  }
};

const activityLine = (element: AgentActivity): string => {
  switch (element.type) {
    case "subscribed":
      return `agent: subscribed${element.running.length === 0 ? "" : `; running in ${element.running.join(", ")}`}`;
    case "delta":
      return `${element.sessionId} delta ${element.event.type}${element.event.type === "text-delta" ? ` ${JSON.stringify(element.event.delta)}` : ""}`;
    case "tool-output":
      return `${element.sessionId} tool output ${element.toolCallId} ${JSON.stringify(element.chunk)}`;
    case "turn-started":
      return `${element.sessionId} turn started ${element.turnId}`;
    case "turn-ended":
      return `${element.sessionId} turn ended ${element.turnId} (${element.reason})`;
    case "queue-changed":
      return `${element.sessionId} queue ${element.queue.length === 0 ? "empty" : element.queue.map((queued) => `${queued.mode} ${queued.requestId}`).join(", ")}`;
  }
};

const sessionsLine = (element: SessionsChange): string => {
  switch (element.type) {
    case "subscribed":
      return "sessions: subscribed";
    case "session-changed":
      return `${element.info.id} changed${element.info.title === undefined ? "" : ` "${element.info.title}"`}`;
    case "session-removed":
      return `${element.sessionId} deleted`;
  }
};

const llmLine = (element: LlmChange): string => (element.type === "subscribed" ? "models: subscribed" : "models changed");

const appendedLine = (sessionId: string, seq: number, type: string) => `${sessionId} appended #${seq} ${type}`;

const logLines = (sessionId: string, update: SessionLogUpdate): string =>
  update.type === "appended"
    ? appendedLine(sessionId, update.event.seq, update.event.data.type)
    : [`${sessionId} log: subscribed`, ...update.events.map((event) => appendedLine(sessionId, event.seq, event.data.type))].join("\n");

const uiLine = (ui: UiComposition): string => {
  const rows = Object.entries(ui.plugins).map(([id, row]) => `${id}${row.enabled === false ? "=off" : ""}${row.config === undefined ? "" : "+config"}`);
  return `ui: ${rows.length ? rows.join(" ") : "no rows"}; files ${ui.files.length ? ui.files.map((file) => `${file.source}/${file.name}`).join(" ") : "none"}`;
};

export const questionsCommand: Command = ({ rpc }) =>
  Effect.map(rpc["Interaction.List"](), (questions) => ({ json: questions, text: formatQuestions(questions) }));

export const answerCommand =
  (id: string, words: readonly string[]): Command =>
  ({ rpc }) =>
    Effect.gen(function* () {
      const request = (yield* rpc["Interaction.List"]()).find((candidate) => candidate.id === id);
      if (request === undefined) return yield* new CliError({ code: "NotFound", message: `No open question ${id}`, subject: id, exit: ExitCode.failed });
      const answer = toAnswer(request, words.join(" "));
      if (typeof answer === "string") return yield* usage(answer);
      yield* rpc["Interaction.Answer"]({ id, answer });
      return { json: { answered: id, answer }, text: `answered "${request.title}"` };
    });

export const dismissCommand =
  (id: string): Command =>
  ({ rpc }) =>
    Effect.as(rpc["Interaction.Dismiss"]({ id }), { json: { dismissed: id }, text: `dismissed ${id}` });

// ------------------------------------------------------------------ providers and models

export const modelsCommand: Command = ({ rpc }, _io, options) =>
  Effect.map(call(rpc, LlmChannels.models, options.all ? {} : { available: true }), (models) => ({ json: models, text: formatModels(models) }));

export const providersCommand: Command = ({ rpc }) =>
  Effect.map(call(rpc, LlmChannels.providers, undefined), (providers) => ({ json: providers, text: formatProviders(providers) }));

/**
 * `lemma login <provider>`: runs the provider's login, answering its questions
 * per the policy, and holding them only if it can answer them (`answering`):
 * with neither a terminal nor answers, they go to another client, as a
 * `run`'s do. Its link and one-time code print on lines of their own, so
 * they copy whole into a browser anywhere; with a browser here, the link opens
 * in it and Enter opens a code's page. A browser on another machine ends on a
 * page that cannot reach the host, so the paste prompt asks for that page's
 * address. Ctrl+C cancels the login on the host, which otherwise outlives the
 * command. A login its provider's reload ended fails (`refined`), as does
 * one whose connection dropped (`callOn`): running the command again starts
 * one anew, asking its questions again.
 */
export const loginCommand =
  (provider: string): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const info = (yield* call(connection.rpc, LlmChannels.providers, undefined)).find((candidate) => candidate.id === provider);
      if (info === undefined)
        return yield* new CliError({ code: "UnknownProvider", message: `No provider "${provider}"`, subject: provider, exit: ExitCode.failed });
      const method = options.method ?? info.auth[0]?.type;
      if (method !== "api_key" && method !== "oauth") return yield* usage(`--method must be one of ${info.auth.map((auth) => auth.type).join(", ")}`);
      if (!info.auth.some((auth) => auth.type === method))
        return yield* usage(`${provider} does not offer ${method}; it offers ${info.auth.map((auth) => auth.type).join(", ")}`);
      const { host, events } = yield* hearing(connection, answering(io, options));
      const origin = `login:${provider}`;
      /** The paste-the-address fallback of a sign-in page, as the host marks it. */
      const isPaste = (request: InteractionRequest) => request.type === "ask" && request.kind === "sign-in-code";
      /** Set once Ctrl+C cancels: the questions the host withdraws for it were not answered elsewhere. */
      let cancelling = false;
      /** The login's link, once shown. */
      const linkShown = yield* Deferred.make<void>();
      const questions = yield* questionHandler(host, io, options, origin, {
        // Questions and notices reach a client on separate streams: the paste prompt can overtake the link it follows.
        before: (request) =>
          isPaste(request) ? Deferred.await(linkShown).pipe(Effect.timeoutOrElse({ duration: Duration.millis(500), orElse: () => Effect.void })) : Effect.void,
        prompt: (request) => (isPaste(request) ? "If the browser ends on a page that won't load, paste its address here: " : undefined),
        // The browser reached the host first, so signing in goes on without it; or this command is cancelling it.
        closed: (request) => (cancelling || isPaste(request) ? "" : "(answered elsewhere)"),
      });
      /** Whether this terminal answers questions: Enter to open a code's page is one. */
      const asks = policyOf(io, options) === "ask" && io.ask !== undefined;
      /** Enter opens a device code's page; the prompt closes when the login ends. */
      const opener = yield* FiberMap.make<string>();
      yield* hostEvents(events, (event) =>
        Effect.gen(function* () {
          if (event.type === "notice") {
            if (options.json || event.notice.origin !== origin) io.err(noticeLine(event));
            else {
              const shown = loginLines(event.notice, info.name, io.open !== undefined);
              if (shown.lines.length > 0) io.err(shown.lines.join("\n"));
              if (shown.link !== undefined && event.notice.kind === "sign-in") {
                yield* Deferred.succeed(linkShown, undefined);
                io.open?.(shown.link);
              }
              if (shown.link !== undefined && event.notice.kind === "device-code" && io.open !== undefined && asks) {
                const url = shown.link;
                yield* FiberMap.run(
                  opener,
                  "device",
                  Effect.promise((signal) => io.ask!(`Press Enter to open ${hostOf(url)} in your browser… `, false, signal)).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        io.open!(url);
                        io.err("Waiting for you to approve…");
                      }),
                    ),
                  ),
                );
              }
            }
          }
          yield* questions(event);
        }),
      );
      yield* callOn(host, LlmChannels.login, { provider, type: method }).pipe(
        Effect.onInterrupt(() =>
          Effect.andThen(
            Effect.sync(() => {
              cancelling = true;
            }),
            Effect.andThen(
              callOn(host, LlmChannels.cancelLogin, { provider }).pipe(Effect.ignore),
              Effect.sync(() => io.err(`Cancelled the ${info.name} login.`)),
            ),
          ),
        ),
        Effect.ensuring(FiberMap.clear(opener)),
      );
      return { json: { loggedIn: provider, method }, text: `logged in to ${info.name}` };
    });

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * A login's notice for the terminal, by its kind: the sign-in page and the
 * code alone on their lines, unindented, so a wrapped link still copies
 * whole; a documentation link on its own line under what it explains. Its
 * success and end print nothing: the command's own result says them. `link`
 * is the page a sign-in or code names.
 */
export const loginLines = (notice: NoticePayload, providerName: string, canOpen: boolean): { readonly lines: readonly string[]; readonly link?: string } => {
  const link = notice.links?.[0]?.url;
  switch (notice.kind) {
    case "device-code":
      return notice.code === undefined || link === undefined
        ? { lines: [notice.message] }
        : {
            link,
            lines: ["", `First copy your one-time code: ${notice.code}`, `Then enter it at ${link}`, "Only enter this code if you started this sign-in.", ""],
          };
    case "sign-in":
      return link === undefined
        ? { lines: [notice.message] }
        : {
            link,
            lines: [
              "",
              `Sign in to ${providerName} in your browser:`,
              "",
              link,
              "",
              canOpen
                ? "Opened it in your browser here; to use another browser or device, copy the link."
                : "Open it in any browser, on this machine or another.",
              "",
            ],
          };
    case "signed-in":
    case "ended":
      return { lines: [] };
    default:
      return { lines: [notice.message, ...(notice.links ?? []).map((item) => (item.label === undefined ? item.url : `${item.label}: ${item.url}`))] };
  }
};

export const logoutCommand =
  (provider: string): Command =>
  ({ rpc }) =>
    Effect.as(call(rpc, LlmChannels.logout, { provider }), { json: { loggedOut: provider }, text: `logged out of ${provider}` });

// ------------------------------------------------------------------ commands

/** `lemma do`: lists the commands plugins registered. */
export const listCommandsCommand: Command = ({ rpc }) =>
  Effect.map(call(rpc, CommandChannels.list, undefined), (commands) => ({ json: commands, text: formatCommands(commands) }));

/**
 * `lemma do <id>`: runs one, answering its questions per the policy, and
 * holding them only if it can answer them (`answering`). One its
 * plugin's reload stopped fails (`refined`), as does one whose connection
 * dropped (`callOn`), since a command run twice need not do what it does
 * once: whether to run it again is the person's call.
 */
export const doCommand =
  (id: string): Command =>
  (connection, io, options) =>
    Effect.gen(function* () {
      const { host, events } = yield* hearing(connection, answering(io, options));
      const origin = `command:${randomUUID()}`;
      const questions = yield* questionHandler(host, io, options, origin);
      yield* hostEvents(events, (event) =>
        Effect.gen(function* () {
          if (event.type === "notice") io.err(noticeLine(event));
          yield* questions(event);
        }),
      );
      const cwd = resolve(io.cwd, options.cwd ?? ".");
      const result = yield* callOn(host, CommandChannels.run, { id, cwd, origin, ...(options.session === undefined ? {} : { sessionId: options.session }) });
      return { json: { command: id, ...result }, text: result.message ?? `${id}: done` };
    });
