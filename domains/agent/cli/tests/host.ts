import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { Channels, HostError, Notice, serveChannel, withdrawnFrom } from "@lemma/contracts";
import type { Channel, NoticePayload } from "@lemma/contracts";
import { definePlugin, Events, makeLoader, PluginContext } from "@lemma/core";
import type { Loader } from "@lemma/core";
import { AgentChannels } from "@lemma/agent";
import type { AgentActivity, AgentView, PromptOutcome } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import type { AssistantMessage } from "@lemma/llm";
import { SessionChannels } from "@lemma/sessions";
import type { EventData, SessionEvent, SessionLogUpdate } from "@lemma/sessions";
import { CliRunner } from "@lemma/cli";
import type { CliElement, RunRequest } from "@lemma/cli";
import registry from "@lemma/cli-registry";
import agentCli from "../src/index.ts";

/*
 * A host for `lemma run`: the command's own plugin (`agent.cli`) and the
 * runner (`cli.registry`), with the agent's and the sessions' channels served
 * by fakes a test scripts: what the agent's activity sends, what the log gets,
 * and when the prompt's call answers.
 */

export const sessionId = "s1";
export const turnId = "t1";
export const requestId = "r1";

export const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "x",
  provider: "p",
  model: "m",
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: 0,
});
/** The turn's start and the prompt's message, which places it. */
export const started: EventData[] = [
  { type: "turn-start", turnId },
  { type: "message", turnId, requestId, message: { role: "user", content: [{ type: "text", text: "ramble" }], timestamp: 0 } },
];
export const step = (stepId: string, text: string): EventData[] => [
  { type: "step-start", turnId, stepId },
  { type: "message", turnId, stepId, message: answer(text) },
  { type: "step-end", turnId, stepId },
];
export const ended: EventData = { type: "turn-end", turnId, reason: "done" };
export const turnStarted: AgentActivity = { type: "turn-started", sessionId, turnId, requestIds: [requestId] };
export const turnEnded: AgentActivity = { type: "turn-ended", sessionId, turnId, usage: emptyUsage, reason: "done" };
export const word = (stepId: string, seq: number, text = `word${seq} `): AgentActivity => ({
  type: "delta",
  sessionId,
  turnId,
  stepId,
  seq,
  event: { type: "text-delta", index: 0, delta: text },
});
export const idle: AgentView = { output: [], queue: [], queueRevision: 0 };

/** A stream fed by the test: `first` and what `push` sends, until `fail`. */
interface Fed<A> {
  readonly stream: Stream.Stream<A, HostError>;
  readonly push: (...elements: readonly A[]) => void;
  readonly fail: (error: HostError) => void;
}

const fed = <A>(...first: readonly A[]): Fed<A> => {
  let queue: Queue.Queue<A, HostError | Cause.Done> | undefined;
  const pending: A[] = [...first];
  let failure: HostError | undefined;
  return {
    stream: Stream.callback<A, HostError>((opened) =>
      Effect.sync(() => {
        queue = opened;
        for (const element of pending) Queue.offerUnsafe(opened, element);
        pending.length = 0;
        if (failure !== undefined) Queue.failCauseUnsafe(opened, Cause.fail(failure));
      }),
    ),
    push: (...elements) => {
      if (queue === undefined) pending.push(...elements);
      else for (const element of elements) Queue.offerUnsafe(queue, element);
    },
    fail: (error) => {
      failure = error;
      if (queue !== undefined) Queue.failCauseUnsafe(queue, Cause.fail(error));
    },
  };
};

/** A deferred made on first asking, so a waiter and the one that completes it may come in either order. */
const slots = <A, E = never>() => {
  const made = new Map<number, Deferred.Deferred<A, E>>();
  return (n: number) => {
    let slot = made.get(n);
    if (slot === undefined) made.set(n, (slot = Deferred.makeUnsafe<A, E>()));
    return slot;
  };
};

export type Prompt = { readonly sessionId: string; readonly requestId: string; readonly whenBusy?: string; readonly content: readonly unknown[] };

export interface Script {
  /** The session's log before the command runs. */
  readonly log?: readonly EventData[];
  /** What `agent.view` answers. */
  readonly view?: AgentView | ((host: Host) => Effect.Effect<AgentView>);
  /** Sent on each `agent.activity` after its `subscribed`. */
  readonly streamed?: readonly AgentActivity[];
  /**
   * What the agent does with its `n`th `agent.prompt` call (counting calls
   * made again after a reload), answering `placed` unless it returns another
   * outcome. Without it, a call waits for `Host.answer(n)`.
   */
  readonly prompt?: (host: Host, n: number) => Effect.Effect<PromptOutcome | void, HostError>;
  /** Answers `sessions.get` instead, unless it returns undefined. */
  readonly get?: (host: Host) => Effect.Effect<unknown, HostError> | undefined;
}

export interface Host {
  readonly loader: Loader;
  /** Sends elements on the open `agent.activity`. */
  readonly act: (...elements: readonly AgentActivity[]) => void;
  /** Appends to the session's log, which the open `sessions.log` sends. */
  readonly append: (...data: readonly EventData[]) => void;
  readonly logged: readonly SessionEvent[];
  /** The payloads of `agent.prompt`'s calls, in order. */
  readonly prompts: readonly Prompt[];
  /** Resolves once `agent.prompt` has been called `n` times. */
  readonly prompted: (n: number) => Effect.Effect<Prompt>;
  /** Answers the `n`th call of `agent.prompt` that a script's `prompt` leaves waiting. */
  readonly answer: (n: number, outcome?: PromptOutcome) => Effect.Effect<void>;
  /** Resolves once `agent.activity` has been opened `n` times. */
  readonly opened: (n: number) => Effect.Effect<void>;
  /** Fails the open `agent.activity` as the transport does when its plugin leaves. */
  readonly withdraw: () => void;
  /** Replaces the fake agent, as a reload does: what it serves is withdrawn, and served again by its replacement. */
  readonly reload: Effect.Effect<void>;
  /** Publishes the host's notices. */
  readonly notify: (...notices: readonly NoticePayload[]) => Effect.Effect<void>;
}

/** Runs `body` against a host scripted by `script`, closing it afterwards. */
export const withHost = <A, E>(script: Script, body: (host: Host) => Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const logged: SessionEvent[] = [];
        const activities: Fed<AgentActivity>[] = [];
        const logs: Fed<SessionLogUpdate>[] = [];
        const prompts: Prompt[] = [];
        const called = slots<Prompt>();
        const answers = slots<PromptOutcome>();
        const opens = slots<void>();
        const append = (...data: readonly EventData[]) => {
          for (const item of data) {
            const seq = logged.length + 1;
            const event: SessionEvent = { seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: 1000 + seq, data: item };
            logged.push(event);
            logs.at(-1)?.push({ type: "appended", event });
          }
        };
        append(...(script.log ?? []));
        const info = () => ({
          id: sessionId,
          cwd: "/",
          createdAt: 0,
          updatedAt: 0,
          lastSeq: logged.length,
          ...(logged.length ? { leaf: logged.at(-1)!.id } : {}),
        });

        let host: Host;
        const agentChannels: readonly Channel[] = [
          // It stops when the agent leaves, as the agent's own does (`CallLifetime`): the host makes it again on the replacement.
          serveChannel(AgentChannels.prompt, (payload, lifetime) =>
            Effect.raceFirst(
              Effect.gen(function* () {
                prompts.push(payload as Prompt);
                const n = prompts.length;
                Deferred.doneUnsafe(called(n), Effect.succeed(payload as Prompt));
                const outcome = script.prompt === undefined ? yield* Deferred.await(answers(n)) : yield* script.prompt(host, n);
                return outcome ?? { kind: "placed" as const };
              }),
              lifetime.left,
            ),
          ),
          serveChannel(AgentChannels.view, () => {
            const view = script.view ?? idle;
            return typeof view === "function" ? view(host) : Effect.succeed(view);
          }),
          serveChannel(AgentChannels.activity, () => {
            const opened = fed<AgentActivity>({ type: "subscribed", running: [] }, ...(script.streamed ?? []));
            activities.push(opened);
            Deferred.doneUnsafe(opens(activities.length), Effect.void);
            return opened.stream;
          }),
        ];
        const sessionChannels: readonly Channel[] = [
          serveChannel(SessionChannels.get, () => script.get?.(host) ?? Effect.sync(info)),
          serveChannel(SessionChannels.events, () => Effect.sync(() => [...logged])),
          serveChannel(SessionChannels.create, () => Effect.sync(info)),
          serveChannel(SessionChannels.log, ({ after }) => {
            const opened = fed<SessionLogUpdate>({ type: "subscribed", events: logged.filter((event) => event.seq > (after ?? 0)) });
            logs.push(opened);
            return opened.stream;
          }),
        ];
        const serving = (id: string, channels: readonly Channel[]) =>
          definePlugin({
            id,
            layer: Layer.effectDiscard(
              Effect.flatMap(PluginContext, (owner) => Effect.forEach(channels, (channel) => owner.add(Channels, channel), { discard: true })),
            ),
          });
        const plugins = new Map(
          [serving("fake.sessions", sessionChannels), serving("fake.agent", agentChannels), registry, agentCli].map((plugin) => [plugin.id, plugin]),
        );
        const loader = yield* makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins.get(id)!) },
          composition: { plugins: { "fake.sessions": {}, "fake.agent": {}, "cli.registry": {}, "agent.cli": {} } },
        });
        const events = yield* loader.core.run(Events);
        host = {
          loader,
          act: (...elements) => activities.at(-1)!.push(...elements),
          append,
          logged,
          prompts,
          prompted: (n) => Deferred.await(called(n)),
          answer: (n, outcome = { kind: "placed" }) => Deferred.succeed(answers(n), outcome).pipe(Effect.asVoid),
          opened: (n) => Deferred.await(opens(n)),
          withdraw: () => activities.at(-1)!.fail(withdrawnFrom(AgentChannels.activity.id, "stream")),
          reload: Effect.asVoid(loader.core.restart("fake.agent", { force: true })).pipe(Effect.orDie),
          notify: (...notices) => Effect.forEach(notices, (notice) => events.publish(Notice, notice), { discard: true }),
        };
        return yield* body(host);
      }),
    ),
  );

export interface RunOptions {
  readonly session?: string;
  readonly prompt?: readonly string[];
  readonly follow?: boolean;
  readonly json?: boolean;
  /** The id given with --request-id; undefined, when the key is there, gives none. */
  readonly requestId?: string | undefined;
  readonly flags?: Readonly<Record<string, unknown>>;
}

/** What a run sent: its text (stdout's, and stderr's as `said`), its JSON lines, its result, and how it ended. */
export interface Ran {
  readonly elements: readonly CliElement[];
  readonly shown: string;
  readonly said: string;
  readonly lines: readonly unknown[];
  readonly result: Extract<CliElement, { readonly type: "result" }> | undefined;
  readonly exit: Exit.Exit<void, HostError>;
}

export interface Running {
  /** Resolves once the run has shown `text` on stdout. */
  readonly showing: (text: string) => Effect.Effect<void>;
  /** Resolves once the run has sent an element `matches` accepts. */
  readonly sent: (matches: (element: CliElement) => boolean) => Effect.Effect<void>;
  readonly done: Effect.Effect<Ran>;
}

const ran = (elements: readonly CliElement[], exit: Exit.Exit<void, HostError>): Ran => {
  const text = (err: boolean) =>
    elements
      .filter((element) => element.type === "text" && (element.err === true) === err)
      .map((element) => (element.type === "text" ? element.text : ""))
      .join("");
  return {
    elements,
    shown: text(false),
    said: text(true),
    lines: elements.flatMap((element) => (element.type === "json" ? [element.value] : [])),
    result: elements.find((element) => element.type === "result") as Ran["result"],
    exit,
  };
};

/** `lemma run s1 ramble --follow --request-id r1` (or as `options` say), started on `host`. */
export const startRun = (host: Host, options: RunOptions = {}): Effect.Effect<Running, never, Scope.Scope> =>
  Effect.gen(function* () {
    const id = "requestId" in options ? options.requestId : requestId;
    const request: RunRequest = {
      path: ["run"],
      input: {
        args: { session: options.session ?? sessionId, prompt: options.prompt ?? ["ramble"] },
        flags: { follow: options.follow ?? true, image: [], steer: false, ...(id === undefined ? {} : { "request-id": id }), ...options.flags },
      },
      cwd: "/work",
      json: options.json ?? false,
      origin: "cli:test",
    };
    const elements: CliElement[] = [];
    const waiting: { readonly holds: () => boolean; readonly done: Deferred.Deferred<void> }[] = [];
    const check = () => {
      for (const waiter of waiting) if (waiter.holds()) Deferred.doneUnsafe(waiter.done, Effect.void);
    };
    const until = (holds: () => boolean) =>
      Effect.suspend(() => {
        if (holds()) return Effect.void;
        const done = Deferred.makeUnsafe<void>();
        waiting.push({ holds, done });
        return Deferred.await(done);
      });
    const runner = yield* Effect.orDie(host.loader.core.run(CliRunner));
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(runner.run(request), (element) =>
        Effect.sync(() => {
          elements.push(element);
          check();
        }),
      ),
    );
    return {
      showing: (text) => until(() => ran(elements, Exit.void).shown.includes(text)),
      sent: (matches) => until(() => elements.some(matches)),
      done: Effect.map(Fiber.await(fiber), (exit) => ran(elements, exit)),
    };
  });

/** Runs it to its end. */
export const run = (host: Host, options?: RunOptions) => Effect.flatMap(startRun(host, options), (running) => running.done);

/** What a run failed with. */
export const failure = (exit: Exit.Exit<void, HostError>): HostError => {
  if (Exit.isSuccess(exit)) throw new Error("the run succeeded");
  return Cause.squash(exit.cause) as HostError;
};

/** Runs it to its end, failing the test if it failed. */
export const follow = (host: Host, options?: RunOptions) =>
  Effect.map(run(host, options), (result) => {
    if (Exit.isFailure(result.exit)) throw new Error(`run failed: ${String(Cause.squash(result.exit.cause))}`);
    return result;
  });
