import { Effect, FiberMap, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { formValues, HostError } from "@lemma/contracts";
import type { InteractionAnswer, InteractionRequest, RuntimeEvent } from "@lemma/contracts";
import { dropped } from "@lemma/client";
import type { Host } from "@lemma/client";
import { connectedAfter, received } from "./channels.ts";
import type { Connection, Failure, Globals, Io } from "./command.ts";
import { formLines } from "./format.ts";

/**
 * The questions the host asks while a command is attached (a tool asking to
 * confirm, a login's API key): which a command answers, and how, by the
 * `--questions` policy and `--answer` values.
 */

// ------------------------------------------------------------------ questions

const policyOf = (io: Io, globals: Pick<Globals, "questions">) => globals.questions ?? (io.ask === undefined ? "ignore" : "ask");

/**
 * Whether a command answers the host's questions, so the host holds them for
 * it: if and only if it can, having answers to give (`--answer`), dismissing
 * them, or asking at a terminal it has. Otherwise (`ignore`, or `ask` with no
 * terminal) it leaves them to another client that answers, or with none, the
 * question fails as unanswerable, which a tool asking for approval takes as
 * a no. It is decided once, as the command connects: once its `--answer`
 * values run out, it still holds the questions it then ignores.
 */
export const answering = (io: Io, globals: Pick<Globals, "questions" | "answers">): boolean => {
  const policy = policyOf(io, globals);
  return globals.answers.length > 0 || policy === "dismiss" || (policy === "ask" && io.ask !== undefined);
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
    case "form": {
      let given: unknown;
      try {
        given = JSON.parse(raw);
      } catch {
        return `Answer "${request.title}" with its fields as JSON: ${formExample(request)}`;
      }
      const read = formValues(request.fields, given);
      return "error" in read ? `${read.error}: answer as ${formExample(request)}` : { type: "form", value: read.value };
    }
  }
};

/** A form's fields as the JSON that answers it, each with a value of its type, or its default. */
const formExample = (request: Extract<InteractionRequest, { type: "form" }>): string =>
  JSON.stringify(
    Object.fromEntries(
      request.fields.map((field) => [
        field.key,
        field.default ?? { string: "…", number: 0, integer: 0, boolean: false, enum: field.options?.[0] ?? "…", strings: ["…"], other: null }[field.type],
      ]),
    ),
  );

const promptText = (request: InteractionRequest): string => {
  switch (request.type) {
    case "confirm":
      return `${request.title}${request.detail === undefined ? "" : `\n${request.detail}`} [y/n] `;
    case "ask":
      return `${request.title}${request.placeholder === undefined ? "" : ` (${request.placeholder})`}: `;
    case "select":
      return `${request.title}${request.detail === undefined ? "" : `\n${request.detail}`}\n${request.options.map((option, i) => `  ${i + 1}. ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`).join("\n")}\n> `;
    case "form":
      return [
        request.title,
        ...(request.detail === undefined ? [] : [request.detail]),
        ...formLines(request),
        `Answer as JSON, such as ${formExample(request)}`,
        "> ",
      ].join("\n");
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
 * holds no question then, see `answering`). Only questions whose origin
 * `ours` accepts are handled, so answers never reach another session's or
 * client's question; `undefined` handles every question (`events --answer`).
 *
 * The handler takes every event the command hears (`hearing`), in order. An
 * `--answer` is sent before the next event is handled, so the values go to
 * questions in the order they arrive, and one is used up unless it surely
 * reached a question already closed (`NotFound`: answered elsewhere or
 * withdrawn, as a question the host sends on connecting may be by the time
 * it is handled), when it goes to the next question; one a dropped
 * connection cut off may have answered its own, so is used up (`reply`). Any
 * other question is handled in its own fiber, so events keep flowing while
 * the terminal waits, and its prompt closes when the question is answered
 * elsewhere or the command ends. The host sends the questions still open to
 * every client that subscribes, so those open as the command connects reach
 * the person. A dropped connection loses the events meanwhile, so one asked
 * during the drop (a tool's approval) reaches them once the connection is
 * back, as it subscribes anew; the prompt of one that closed meanwhile
 * closes then, as `Interaction.List` no longer has it; and an answer given
 * while it was down goes once it is back.
 */
export const questionHandler = (
  host: Host,
  io: Io,
  globals: Pick<Globals, "questions" | "answers">,
  ours: ((origin: string | undefined) => boolean) | undefined,
  view: QuestionView = {},
) =>
  Effect.gen(function* () {
    const answers = [...globals.answers];
    const seen = new Set<string>();
    const prompts = yield* FiberMap.make<string>();
    /** Questions waiting at the terminal now. */
    const prompting = new Map<string, InteractionRequest>();
    /**
     * Sends an answer or a dismissal, again on the next connection when the
     * connection dropped first: the first answer wins, so a second is safe.
     * Says whether the question had closed before it came (answered
     * elsewhere, or withdrawn): only when the host's first reply is
     * `NotFound`, which is certain. One the connection dropped while it was on
     * its way may have arrived and closed the question itself, so a `NotFound`
     * when it is sent again says nothing, and it is not said to have. Any
     * other refusal is not this command's concern.
     */
    const reply = (send: () => Promise<void>, again = false): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const { generation } = host.status();
        return Effect.tryPromise({ try: send, catch: (error) => error }).pipe(
          Effect.as(false),
          Effect.catch((error) =>
            dropped(error)
              ? Effect.andThen(connectedAfter(host, generation), reply(send, true))
              : Effect.succeed(!again && error instanceof HostError && error.code === "NotFound"),
          ),
        );
      });
    const handle = (request: InteractionRequest, next: string | undefined) =>
      Effect.gen(function* () {
        const policy = policyOf(io, globals);
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
      if (seen.has(request.id) || (ours !== undefined && !ours(request.origin))) return Effect.void;
      seen.add(request.id);
      const next = answers.shift();
      const answer = next === undefined ? undefined : toAnswer(request, next);
      // With no `--answer` left, the policy has it; with one that does not answer it, `handle` says so and asks at a terminal.
      if (next === undefined || answer === undefined || typeof answer === "string")
        return Effect.asVoid(FiberMap.run(prompts, request.id, handle(request, next)));
      // Sent before the next event is handled, so `--answer` values go to questions in the order they arrive, and one that
      // surely reached a question already closed goes back for the next.
      return Effect.map(
        reply(() => host.interaction.answer(request.id, answer)),
        (closed) => {
          if (closed) answers.unshift(next);
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
  return `[${notice.level}]${notice.source === undefined ? "" : ` ${notice.source}:`} ${notice.message}${links}`;
};
