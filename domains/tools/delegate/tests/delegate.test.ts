import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, Hooks, makeCore, PluginContext, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { callHere } from "@lemma/cli";
import { Channels, Interaction, InteractionError, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { AgentChannels, AgentError, AgentRequestHook, ModeChannels, ModelNotice, PromptSections } from "@lemma/agent";
import type { PromptOutcome, RequestDraft, TurnOptions } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import { SessionAppended, SessionChannels, SessionError } from "@lemma/sessions";
import type { EventData, SessionEvent, SessionInfo, SessionParent } from "@lemma/sessions";
import { ToolInvocation, ToolRunner } from "@lemma/tools";
import type { ToolResult } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import tools from "@lemma/tools-registry";
import delegate from "../src/index.ts";
import { DelegateChannels } from "../src/channels.ts";
import { jobFiles } from "../src/jobs.ts";
import { forkPoint, lastTurnOptions } from "../src/lineage.ts";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** A prompt the fake agent placed: its session, request id, content, and options. */
interface Placed {
  readonly sessionId: string;
  readonly requestId: string;
  readonly text: string;
  readonly options?: TurnOptions | undefined;
  readonly whenBusy?: string | undefined;
}

interface State {
  readonly sessions: Map<string, { info: SessionInfo; log: SessionEvent[] }>;
  readonly placed: Placed[];
  readonly cancelled: string[];
  readonly deleted: string[];
  readonly forked: { readonly sessionId: string; readonly eventId: string }[];
  readonly notices: { readonly sessionId: string; readonly id: string; readonly text: string; readonly display?: string | undefined }[];
  /** Turns waiting to end, by session: "hang" and "wait" prompts. */
  release?: Deferred.Deferred<void>;
  /** How many notices to drop before the agent hears them, as while it reloads. */
  deaf?: number;
  /** The request ids Stop asked to withdraw, and those of prompts waiting behind another turn ("behind"). */
  readonly withdrawn: string[];
  readonly behind: string[];
  /** Sessions whose log, once their turn ended, cannot be read ("unreadable"). */
  readonly unreadable: Set<string>;
  /** Sessions whose turn runs from before the test (a restart cut the waiting off): asked again, it waits for it. */
  running?: readonly string[];
  modes?: readonly { name: string; description?: string; model?: string; thinking?: string; use?: ("thread" | "agent")[]; source: "bundled" }[];
}

const fresh = (): State => ({
  sessions: new Map(),
  placed: [],
  cancelled: [],
  deleted: [],
  forked: [],
  notices: [],
  withdrawn: [],
  behind: [],
  unreadable: new Set(),
});

/**
 * The sessions store, the agent, and the modes, faked as the channels a client reaches: a prompt makes a turn that
 * answers "did: <prompt>", runs until cancelled on "hang", waits for `release` on "wait", is refused on "refuse", and
 * deletes its session as it ends on "vanish". On "behind" it waits queued behind another turn, unlogged, until
 * withdrawn; on "unreadable" its log cannot be read once its turn ends. A cancel ends a hanging turn as cancelled and
 * answers once it has, after the prompt waiting on it, as the agent does.
 */
const fakes = (state: State) => {
  let made = 0;
  const hanging = new Map<string, { readonly turnId: string; readonly ended: Deferred.Deferred<void> }>();
  const queuedBehind = new Map<string, Deferred.Deferred<void, AgentError>>();
  for (const sessionId of state.running ?? []) hanging.set(sessionId, { turnId: "t-before", ended: Deferred.makeUnsafe<void>() });
  const append = (sessionId: string, data: EventData) => {
    const session = state.sessions.get(sessionId)!;
    const event: SessionEvent = {
      seq: session.log.length + 1,
      id: `${sessionId}-${session.log.length + 1}`,
      parent: session.log.at(-1)?.id ?? null,
      at: session.log.length,
      data,
    };
    session.log.push(event);
    session.info = { ...session.info, lastSeq: event.seq, leaf: event.id, ...(data.type === "title" ? { title: data.title } : {}) };
    return event;
  };
  const make = (cwd: string, parent?: SessionParent): SessionInfo => {
    const id = `a${++made}`;
    const info: SessionInfo = { id, cwd, createdAt: made, updatedAt: made, lastSeq: 0, ...(parent === undefined ? {} : { parent }) };
    state.sessions.set(id, { info, log: [] });
    return info;
  };
  const missing = (sessionId: string) => new SessionError({ sessionId, reason: "NotFound", message: `Session ${sessionId} does not exist` });
  return definePlugin({
    id: "fakes",
    setup: function* (_, owner) {
      const events = yield* Events;
      const channels: Channel[] = [
        serveChannel(SessionChannels.create, ({ cwd, parent }) => make(cwd ?? "/work", parent)),
        serveChannel(SessionChannels.fork, ({ sessionId, eventId, parent }) => {
          const source = state.sessions.get(sessionId);
          if (source === undefined) return Effect.fail(missing(sessionId));
          state.forked.push({ sessionId, eventId });
          const info = make(source.info.cwd, parent);
          const upTo = source.log.findIndex((event) => event.id === eventId);
          for (const event of source.log.slice(0, upTo + 1)) append(info.id, event.data);
          return state.sessions.get(info.id)!.info;
        }),
        serveChannel(SessionChannels.list, ({ cwd }) =>
          [...state.sessions.values()].map((session) => session.info).filter((info) => cwd === undefined || info.cwd === cwd),
        ),
        serveChannel(SessionChannels.get, ({ sessionId }) => state.sessions.get(sessionId)?.info ?? Effect.fail(missing(sessionId))),
        serveChannel(SessionChannels.events, ({ sessionId }) =>
          state.unreadable.has(sessionId)
            ? Effect.fail(new SessionError({ sessionId, reason: "Io", message: "The disk did not answer" }))
            : (state.sessions.get(sessionId)?.log ?? Effect.fail(missing(sessionId))),
        ),
        serveChannel(SessionChannels.setTitle, ({ sessionId, title }) => {
          append(sessionId, { type: "title", title });
          return state.sessions.get(sessionId)!.info;
        }),
        serveChannel(SessionChannels.delete, ({ sessionId }) => {
          state.sessions.delete(sessionId);
          state.deleted.push(sessionId);
          return Effect.void;
        }),
        serveChannel(AgentChannels.cancel, ({ sessionId }) =>
          Effect.gen(function* () {
            state.cancelled.push(sessionId);
            const turn = hanging.get(sessionId);
            if (turn === undefined) return;
            hanging.delete(sessionId);
            append(sessionId, { type: "turn-end", turnId: turn.turnId, reason: "cancelled" });
            yield* Deferred.succeed(turn.ended, undefined);
            for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
          }),
        ),
        serveChannel(AgentChannels.withdraw, ({ sessionId, requestId }) =>
          Effect.gen(function* () {
            state.withdrawn.push(requestId);
            const waiting = queuedBehind.get(requestId);
            if (waiting === undefined) return false;
            queuedBehind.delete(requestId);
            yield* Deferred.fail(waiting, new AgentError({ sessionId, reason: "Retracted", message: "Withdrawn before a turn placed it" }));
            return true;
          }),
        ),
        serveChannel(ModeChannels.list, () => ({ modes: state.modes ?? [], default: "work" })),
        serveChannel(AgentChannels.prompt, ({ sessionId, content, requestId, options, whenBusy }) =>
          Effect.gen(function* (): Effect.fn.Return<PromptOutcome, AgentError | SessionError> {
            const session = state.sessions.get(sessionId);
            if (session === undefined) return yield* missing(sessionId);
            const text = content[0]?.type === "text" ? content[0].text : "";
            if (text === "refuse") return yield* new AgentError({ sessionId, reason: "NoModel", message: "Unknown model: mock/nope" });
            // Asked again with a request id it placed: waits on that turn, placing nothing.
            if (session.log.some((event) => event.data.type === "message" && event.data.requestId === requestId)) {
              const turn = hanging.get(sessionId);
              if (turn !== undefined) yield* Deferred.await(turn.ended);
              return { kind: "placed" };
            }
            if (text === "behind") {
              const waiting = yield* Deferred.make<void, AgentError>();
              queuedBehind.set(requestId, waiting);
              state.behind.push(requestId);
              yield* Deferred.await(waiting);
              return { kind: "placed" };
            }
            state.placed.push({ sessionId, requestId, text, options, whenBusy });
            const turnId = `t${state.placed.length}`;
            append(sessionId, {
              type: "turn-start",
              turnId,
              ...(options?.model === undefined ? {} : { model: options.model }),
              ...(options?.plugins === undefined ? {} : { plugins: options.plugins }),
            });
            append(sessionId, { type: "message", turnId, requestId, message: { role: "user", content: [...content], timestamp: 0 } });
            if (text === "hang") {
              const ended = yield* Deferred.make<void>();
              hanging.set(sessionId, { turnId, ended });
              yield* Deferred.await(ended);
              return { kind: "placed" };
            }
            if (text === "wait") yield* Deferred.await(state.release!);
            const stepId = `${turnId}-p1`;
            append(sessionId, { type: "step-start", turnId, stepId });
            const message = {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: `did: ${text}` }],
              api: "x",
              provider: "p",
              model: "m",
              usage: emptyUsage,
              stopReason: "stop" as const,
              timestamp: 0,
            };
            append(sessionId, { type: "message", turnId, stepId, message });
            append(sessionId, { type: "step-end", turnId, stepId });
            append(sessionId, { type: "turn-end", turnId, reason: "done" });
            if (text === "vanish") state.sessions.delete(sessionId);
            if (text === "unreadable") state.unreadable.add(sessionId);
            return { kind: "placed" };
          }),
        ),
      ];
      for (const channel of channels) yield* owner.add(Channels, channel);
      // The agent's part of a notice: placed as the plugin's context event in the thread, which the store announces.
      yield* owner.observe(ModelNotice, ({ sessionId, id, source, content, display }) =>
        Effect.gen(function* () {
          const text = content[0]?.type === "text" ? content[0].text : "";
          if ((state.deaf ?? 0) > 0) {
            state.deaf!--;
            return;
          }
          state.notices.push({ sessionId, id, text, display });
          const session = state.sessions.get(sessionId);
          if (session === undefined) return;
          const event = append(sessionId, {
            type: "context",
            source,
            content: [...content],
            requestId: `${source}:${id}`,
            ...(display === undefined ? {} : { display }),
          });
          yield* events.publish(SessionAppended, { sessionId, event });
        }),
      );
    },
  });
};

/** Answers each confirmation with the next answer (`undefined`: nobody is there). */
const answers = (queue: (boolean | undefined)[]) =>
  definePlugin({
    id: "answers",
    provides: [Interaction],
    layer: Layer.succeed(Interaction, {
      confirm: () =>
        Effect.suspend(() => {
          const next = queue.shift();
          return next === undefined ? Effect.fail(new InteractionError({ reason: "Unavailable", message: "No client is attached" })) : Effect.succeed(next);
        }),
      ask: () => Effect.die("not asked"),
      select: () => Effect.die("not asked"),
      form: () => Effect.die("not asked"),
    }),
  });

const withCore = <A, E>(
  state: State,
  body: Effect.Effect<A, E, ToolRunner | Registries | Events | Hooks>,
  setup: {
    readonly config?: Record<string, unknown>;
    readonly answers?: (boolean | undefined)[];
    readonly extra?: readonly Plugin[];
    /** The plugins' clock too is the test's, which the body moves on. */
    readonly testClock?: boolean;
  } = {},
) => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([pathsPlugin(home), tools, answers(setup.answers ?? []), fakes(state), delegate, ...(setup.extra ?? [])], {
        configs: { "tools.delegate": setup.config ?? {} },
      });
      return yield* core.run(body);
    }),
  );
  return Effect.runPromise(setup.testClock === true ? program.pipe(Effect.provide(TestClock.layer())) : program);
};

/** A thread a person started, with a finished turn on a model, as the caller. */
const caller = (state: State, id = "p") => {
  const log: SessionEvent[] = [];
  const add = (data: EventData) => log.push({ seq: log.length + 1, id: `${id}-${log.length + 1}`, parent: log.at(-1)?.id ?? null, at: 0, data });
  add({ type: "turn-start", turnId: "t0", model: "anthropic/opus", thinking: "high" });
  add({ type: "message", turnId: "t0", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
  add({ type: "turn-end", turnId: "t0", reason: "done" });
  add({ type: "turn-start", turnId: "t1", model: "anthropic/opus", thinking: "high" });
  state.sessions.set(id, { info: { id, cwd: "/work", createdAt: 0, updatedAt: 0, lastSeq: log.length, leaf: log.at(-1)!.id }, log });
  return id;
};

const call = (
  input: unknown,
  options: { readonly sessionId?: string; readonly toolCallId?: string; readonly signal?: AbortSignal; readonly cwd?: string } = {},
) =>
  Effect.flatMap(ToolRunner, (runner) =>
    runner.execute(
      new ToolInvocation({ sessionId: options.sessionId ?? "p", toolCallId: options.toolCallId ?? "c1", name: "delegate", input, cwd: options.cwd ?? "/work" }),
      options.signal ?? new AbortController().signal,
    ),
  );

/** The agents section's text for a request in "p" offering `tools`, as the agent writes it. */
const sectionFor = (tools: readonly string[]) =>
  Effect.gen(function* () {
    const registries = yield* Registries;
    const section = (yield* registries.items(PromptSections)).find(({ item }) => item.id === "tools.delegate.agents")!.item;
    const request = {
      sessionId: "p",
      turnId: "t",
      cwd: "/work",
      model: { provider: "p", id: "m" },
      tools: tools.map((name) => ({ spec: { name } })),
      branch: [],
    };
    const text = section.text(request as never);
    return yield* Effect.isEffect(text)
      ? (text as Effect.Effect<string | undefined>)
      : Effect.promise(async () => (await (text as Promise<string | undefined>)) ?? undefined);
  });

const structured = (result: ToolResult) => result.structured as { sessionId: string; title: string; ended: string; answer: string; error?: string };

describe("delegate", () => {
  it("starts an agent of the calling thread, titled, waits for its turn, and resolves to its answer", async () => {
    const state = fresh();
    caller(state);
    const result = await withCore(state, call({ prompt: "Sum the numbers\nin data.csv" }));
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ sessionId: "a1", title: "Sum the numbers", ended: "done", answer: "did: Sum the numbers\nin data.csv" });
    expect(state.sessions.get("a1")!.info).toMatchObject({ parent: { sessionId: "p", toolCallId: "c1" }, title: "Sum the numbers" });
    // Queued behind a turn a person started in it, so the task still runs.
    expect(state.placed[0]).toMatchObject({ sessionId: "a1", requestId: "tools.delegate/c1", whenBusy: "follow-up" });
    // Its views read the agent from its details, its answer's start too.
    expect(result.details).toMatchObject({ sessionId: "a1", title: "Sum the numbers", ended: "done", preview: "did: Sum the numbers\nin data.csv" });
  });

  it("works as the thread does: on its last turn's model and thinking, unless the call names a model", async () => {
    const state = fresh();
    caller(state);
    await withCore(state, Effect.andThen(call({ prompt: "one" }), call({ prompt: "two", model: "openai/gpt" }, { toolCallId: "c2" })));
    // Its depth logged with its first turn, which its own delegations count from.
    expect(state.placed[0]!.options).toEqual({ model: "anthropic/opus", thinking: "high", plugins: { "tools.delegate": { depth: 1 } } });
    expect(state.placed[1]!.options).toEqual({ model: "openai/gpt", plugins: { "tools.delegate": { depth: 1 } } });
  });

  it("run again with the same call (a restart cut it off), finds the agent it started and places nothing twice", async () => {
    const state = fresh();
    caller(state);
    const [first, again] = await withCore(state, Effect.all([call({ prompt: "go" }), call({ prompt: "go" })]));
    expect(structured(again).sessionId).toBe(structured(first).sessionId);
    expect(state.sessions.size).toBe(2);
    expect(state.placed).toHaveLength(1);
    expect(structured(again)).toMatchObject({ ended: "done", answer: "did: go" });
  });

  it("gives an agent a mode offered to agents, with its model and thinking, and refuses one not offered", async () => {
    const state = fresh();
    caller(state);
    state.modes = [
      { name: "explore", description: "Reads", model: "fast/m", thinking: "low", use: ["agent"], source: "bundled" },
      { name: "creator", description: "Lemma", use: ["thread"], source: "bundled" },
      { name: "work", source: "bundled" },
    ];
    const [ok, refused] = await withCore(
      state,
      Effect.all([call({ prompt: "look", mode: "explore" }), call({ prompt: "make", mode: "creator" }, { toolCallId: "c2" })]),
    );
    expect(ok.isError).toBeUndefined();
    expect(state.placed[0]!.options).toEqual({ model: "fast/m", thinking: "low", plugins: { "tools.delegate": { depth: 1 }, "agent.modes": "explore" } });
    expect(ok.details).toMatchObject({ mode: "explore" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('No agent was started: no mode "creator" is offered to agents here (offered: explore, work).');
    expect(state.sessions.size).toBe(2);
  });

  it("forks the thread's finished turns for an agent with context fork, in the thread's mode and directory, and refuses a fork with either its own", async () => {
    const state = fresh();
    const p = caller(state);
    const [forked, refused, elsewhere] = await withCore(
      state,
      Effect.all([
        call({ prompt: "go on", context: "fork", cwd: "/work" }),
        call({ prompt: "x", context: "fork", mode: "explore" }, { toolCallId: "c2" }),
        call({ prompt: "x", context: "fork", cwd: home }, { toolCallId: "c3" }),
      ]),
    );
    // At the last turn that ended: not the turn delegating, still running.
    expect(state.forked).toEqual([{ sessionId: p, eventId: "p-3" }]);
    expect(state.sessions.get(structured(forked).sessionId)!.info.parent).toEqual({ sessionId: p, toolCallId: "c1" });
    expect(state.placed[0]!.options).toEqual({ model: "anthropic/opus", thinking: "high", plugins: { "tools.delegate": { depth: 1 } } });
    expect(forked.details).toMatchObject({ fork: true });
    expect(textOf(refused)).toContain("a forked agent keeps this thread's mode");
    expect(textOf(elsewhere)).toContain("a forked agent works in this thread's directory");
    expect(state.forked).toHaveLength(1);
  });

  it("starts an agent in a directory relative to the thread's, and refuses one that is not there", async () => {
    const state = fresh();
    caller(state);
    await fs.mkdir(path.join(home, "sub"));
    const [made, missing] = await withCore(
      state,
      Effect.all([call({ prompt: "go", cwd: "sub" }, { cwd: home }), call({ prompt: "go", cwd: "nowhere" }, { cwd: home, toolCallId: "c2" })]),
    );
    expect(state.sessions.get(structured(made).sessionId)!.info.cwd).toBe(path.join(home, "sub"));
    expect(textOf(missing)).toBe(`No agent was started: ${path.join(home, "nowhere")} is not a directory on this host.`);
  });

  it("counts depth from each agent's own log, and refuses past the deepest, whatever became of the threads above", async () => {
    const state = fresh();
    caller(state);
    const results = await withCore(
      state,
      Effect.gen(function* () {
        const first = yield* call({ prompt: "one" });
        const second = yield* call({ prompt: "two" }, { sessionId: structured(first).sessionId, toolCallId: "c2" });
        // The threads above it deleted: it is no shallower.
        state.sessions.delete("p");
        state.sessions.delete(structured(first).sessionId);
        return yield* call({ prompt: "three" }, { sessionId: structured(second).sessionId, toolCallId: "c3" });
      }),
      { config: { maxDepth: 2 } },
    );
    expect(state.placed[1]!.options?.plugins).toEqual({ "tools.delegate": { depth: 2 } });
    expect(results.isError).toBe(true);
    expect(textOf(results)).toContain("2 levels deep");
  });

  it("lets agents hand on no task by default: one level deep", async () => {
    const state = fresh();
    caller(state);
    const refused = await withCore(
      state,
      Effect.flatMap(call({ prompt: "one" }), (first) => call({ prompt: "two" }, { sessionId: structured(first).sessionId, toolCallId: "c2" })),
    );
    expect(textOf(refused)).toBe("This thread is an agent 1 level deep, as deep as delegations go (1): do the task here.");
    expect(state.placed).toHaveLength(1);
  });

  it("sends a follow-up to an agent of this thread, steering it, and refuses one to another thread's", async () => {
    const state = fresh();
    caller(state);
    caller(state, "other");
    const [, followed, refused] = await withCore(
      state,
      Effect.gen(function* () {
        const first = yield* call({ prompt: "start" });
        const followed = yield* call({ prompt: "and more", sessionId: structured(first).sessionId }, { toolCallId: "c2" });
        const refused = yield* call({ prompt: "not yours", sessionId: structured(first).sessionId }, { sessionId: "other", toolCallId: "c3" });
        return [first, followed, refused] as const;
      }),
    );
    expect(state.placed[1]).toMatchObject({ sessionId: "a1", requestId: "tools.delegate/c2", whenBusy: "steer" });
    expect(structured(followed)).toMatchObject({ sessionId: "a1", ended: "done", answer: "did: and more" });
    expect(followed.details).toMatchObject({ followUp: true });
    expect(textOf(refused)).toContain("is not an agent this thread started");
  });

  it("refuses a follow-up given what only a new agent takes, rather than leave it out unsaid", async () => {
    const state = fresh();
    caller(state);
    const [one, several] = await withCore(
      state,
      Effect.all([
        call({ prompt: "more", sessionId: "a1", title: "Again" }),
        call({ prompt: "more", sessionId: "a1", mode: "explore", context: "fork", cwd: "sub" }, { toolCallId: "c2" }),
      ]),
    );
    expect(textOf(one)).toBe(
      "No message was sent: title is for a new agent, and a follow-up (sessionId) goes to one that keeps its own. Leave it out, or leave sessionId out to start a new agent.",
    );
    expect(textOf(several)).toContain("No message was sent: mode, context and cwd are for a new agent");
    expect(state.placed).toEqual([]);
  });

  it("leaves no agent behind when the agent refuses the prompt", async () => {
    const state = fresh();
    caller(state);
    const result = await withCore(state, call({ prompt: "refuse" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('No agent was started: "agent.prompt" failed (NoModel): Unknown model: mock/nope.');
    expect(state.deleted).toEqual(["a1"]);
  });

  it("makes no agent for a call stopped while it waits for a slot", async () => {
    const state: State = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    caller(state);
    const controller = new AbortController();
    await withCore(
      state,
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(call({ prompt: "wait" }));
        while (state.placed.length === 0) yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(Effect.exit(call({ prompt: "queued" }, { toolCallId: "c2", signal: controller.signal })));
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        controller.abort();
        yield* Fiber.join(second);
        yield* Deferred.succeed(state.release!, undefined);
        yield* Fiber.join(first);
      }),
      { config: { maxDelegations: 1 } },
    );
    expect([...state.sessions.keys()]).toEqual(["p", "a1"]);
  });

  it("asks before a new agent when configured, and starts none when declined", async () => {
    const state = fresh();
    caller(state);
    const result = await withCore(state, call({ prompt: "go" }), { config: { confirm: true }, answers: [false] });
    expect(textOf(result)).toBe("No agent was started: The person declined it.");
    expect(state.sessions.size).toBe(1);
  });

  it("cancels the agent's turn when the call is cancelled", async () => {
    const state = fresh();
    caller(state);
    const controller = new AbortController();
    await withCore(
      state,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(call({ prompt: "hang" }, { signal: controller.signal })));
        while (state.placed.length === 0) yield* Effect.yieldNow;
        controller.abort();
        yield* Fiber.join(fiber);
      }),
    );
    expect(state.cancelled).toEqual(["a1"]);
  });

  it("runs at most maxDelegations agents at once; the rest wait for one to end", async () => {
    const state: State = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    caller(state);
    const started = await withCore(
      state,
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(call({ prompt: "wait" }));
        while (state.placed.length === 0) yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(call({ prompt: "quick" }, { toolCallId: "c2" }));
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        const meanwhile = state.placed.length;
        yield* Deferred.succeed(state.release!, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        return meanwhile;
      }),
      { config: { maxDelegations: 1 } },
    );
    expect(started).toBe(1);
    expect(state.placed).toHaveLength(2);
  });
});

describe("background agents", () => {
  it("answer at once, and tell the thread how they finished; the agent's file goes once the thread has heard", async () => {
    const state: State = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    caller(state);
    const result = await withCore(
      state,
      Effect.gen(function* () {
        const result = yield* call({ prompt: "wait", title: "Long job", background: true });
        // Kept while it works, so a restart still tells the thread.
        expect(yield* Effect.promise(() => fs.readdir(path.join(home, "delegate", "agents")))).toHaveLength(1);
        yield* Deferred.succeed(state.release!, undefined);
        while (state.notices.length === 0) yield* Effect.yieldNow;
        // Gone once the thread logged the notice.
        while ((yield* Effect.promise(() => fs.readdir(path.join(home, "delegate", "agents")))).length > 0) yield* Effect.yieldNow;
        return result;
      }),
    );
    expect(structured(result)).toEqual({ sessionId: "a1", title: "Long job", ended: "running", answer: "" });
    expect(result.details).toMatchObject({ background: true, ended: "running" });
    expect(textOf(result)).toContain("in the background");
    expect(state.notices).toEqual([
      {
        sessionId: "p",
        id: "c1",
        display: "Long job finished",
        text: '<agent_result title="Long job" session="a1" ended="done">\ndid: wait\n</agent_result>',
      },
    ]);
  });

  it("are waited on again after a restart, from their files, and the thread is told", async () => {
    const state = fresh();
    caller(state);
    // An agent started before the host stopped, whose prompt was placed but whose thread was not told.
    state.sessions.set("a7", {
      info: { id: "a7", cwd: "/work", parent: { sessionId: "p", toolCallId: "c7" }, createdAt: 1, updatedAt: 1, lastSeq: 0 },
      log: [],
    });
    const dir = path.join(home, "delegate", "agents");
    await jobFiles(dir).save({
      parent: "p",
      child: "a7",
      prompt: "resumed",
      whenBusy: "follow-up",
      requestId: "tools.delegate/c7",
      depth: 1,
      noticeId: "c7",
      title: "Resumed",
    });
    await withCore(
      state,
      Effect.gen(function* () {
        while (state.notices.length === 0 || (yield* Effect.promise(() => jobFiles(dir).all())).length > 0) yield* Effect.yieldNow;
      }),
    );
    expect(state.placed).toEqual([{ sessionId: "a7", requestId: "tools.delegate/c7", text: "resumed", whenBusy: "follow-up", options: undefined }]);
    expect(state.notices[0]).toMatchObject({ sessionId: "p", id: "c7", display: "Resumed finished" });
    expect(await jobFiles(dir).all()).toEqual([]);
  });

  it("tell nothing twice: a thread that heard already before the restart is not told again", async () => {
    const state = fresh();
    const p = caller(state);
    state.sessions.set("a7", { info: { id: "a7", cwd: "/work", parent: { sessionId: p, toolCallId: "c7" }, createdAt: 1, updatedAt: 1, lastSeq: 0 }, log: [] });
    const told = state.sessions.get(p)!;
    told.log.push({
      seq: told.log.length + 1,
      id: "told",
      parent: null,
      at: 0,
      data: { type: "context", source: "tools.delegate", requestId: "tools.delegate:c7", content: [{ type: "text", text: "heard" }] },
    });
    const dir = path.join(home, "delegate", "agents");
    await jobFiles(dir).save({
      parent: p,
      child: "a7",
      prompt: "resumed",
      requestId: "tools.delegate/c7",
      depth: 1,
      noticeId: "c7",
      title: "Resumed",
    });
    await withCore(
      state,
      Effect.gen(function* () {
        while ((yield* Effect.promise(() => fs.readdir(dir))).length > 0) yield* Effect.yieldNow;
      }),
    );
    expect(state.notices).toEqual([]);
  });
});

describe("background agents, when things go wrong", () => {
  it("keep an agent a person wrote to while it waited for a slot, when its prompt is refused", async () => {
    const state: State = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    caller(state);
    await withCore(
      state,
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(call({ prompt: "wait" }));
        while (state.placed.length === 0) yield* Effect.yieldNow;
        const queued = yield* call({ prompt: "refuse", title: "Queued", background: true }, { toolCallId: "c2" });
        expect(queued.details).toMatchObject({ ended: "running", emptyAt: 1 });
        // The person opens it and writes to it before its slot frees.
        const session = state.sessions.get(structured(queued).sessionId)!;
        session.log.push({ seq: 2, id: "mine", parent: session.log.at(-1)!.id, at: 2, data: { type: "custom", kind: "person", data: {} } });
        session.info = { ...session.info, lastSeq: 2 };
        yield* Deferred.succeed(state.release!, undefined);
        yield* Fiber.join(first);
        while (state.notices.length === 0) yield* Effect.yieldNow;
      }),
      { config: { maxDelegations: 1 } },
    );
    expect(state.deleted).toEqual([]);
    expect(state.sessions.has("a2")).toBe(true);
    expect(state.notices[0]).toMatchObject({ display: "Queued failed" });
    expect(state.notices[0]!.text).toContain("It could not start");
  });

  it("end, and tell the thread, when their thread is deleted as their turn ends: none stays working", async () => {
    const state = fresh();
    caller(state);
    const section = await withCore(
      state,
      Effect.gen(function* () {
        yield* call({ prompt: "vanish", title: "Gone", background: true });
        while (state.notices.length === 0) yield* Effect.yieldNow;
        return yield* sectionFor(["delegate"]);
      }),
    );
    expect(state.notices[0]).toMatchObject({ sessionId: "p", display: "Gone failed" });
    expect(state.notices[0]!.text).toContain("Error: Its thread was deleted before it finished.");
    // No longer listed as at work, which would tell the thread to wait for it.
    expect(section ?? "").not.toContain("Gone");
  });

  it("are dropped by Stop while they wait for a slot: never placed, their empty thread deleted, and the thread told", async () => {
    const state: State = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    caller(state);
    const answers = await withCore(
      state,
      Effect.gen(function* () {
        const registries = yield* Registries;
        const first = yield* Effect.forkChild(call({ prompt: "wait" }));
        while (state.placed.length === 0) yield* Effect.yieldNow;
        const queued = yield* call({ prompt: "never", title: "Queued", background: true }, { toolCallId: "c2" });
        const stop = (sessionId: string) => callHere(registries, DelegateChannels.stop, { sessionId });
        const dropped = yield* stop(structured(queued).sessionId);
        while (state.notices.length === 0) yield* Effect.yieldNow;
        // One at work has nothing queued to withdraw: its turn is cancelled.
        const working = yield* stop(state.placed[0]!.sessionId);
        yield* Deferred.succeed(state.release!, undefined);
        yield* Fiber.join(first);
        return { dropped, working };
      }),
      { config: { maxDelegations: 1 } },
    );
    expect(answers).toEqual({ dropped: "dropped", working: "cancelled" });
    expect(state.withdrawn).toEqual(["tools.delegate/c1"]);
    expect(state.cancelled).toEqual(["a1"]);
    expect(state.placed.map((placed) => placed.text)).toEqual(["wait"]);
    expect(state.deleted).toEqual(["a2"]);
    expect(state.notices[0]).toMatchObject({ sessionId: "p", id: "c2", display: "Queued was stopped" });
    expect(state.notices[0]!.text).toContain('ended="cancelled"');
  });

  it("are stopped by withdrawing their prompt while it waits behind another turn, cancelling no turn", async () => {
    const state = fresh();
    caller(state);
    const answer = await withCore(
      state,
      Effect.gen(function* () {
        const registries = yield* Registries;
        const started = yield* call({ prompt: "behind", title: "Behind", background: true });
        while (state.behind.length === 0) yield* Effect.yieldNow;
        const answer = yield* callHere(registries, DelegateChannels.stop, { sessionId: structured(started).sessionId });
        while (state.notices.length === 0) yield* Effect.yieldNow;
        return answer;
      }),
    );
    expect(answer).toBe("withdrawn");
    expect(state.cancelled).toEqual([]);
    expect(state.deleted).toEqual(["a1"]);
    expect(state.notices[0]).toMatchObject({ sessionId: "p", display: "Behind was stopped" });
  });

  it("placed before a restart take no slot when waited on again, and Stop stops their turn rather than dropping them", async () => {
    const state: State = { ...fresh(), running: ["a7", "a8"] };
    caller(state);
    const dir = path.join(home, "delegate", "agents");
    // Two agents at one depth, one slot: each one's prompt was placed, and its turn runs on.
    for (const [child, call] of [
      ["a7", "c7"],
      ["a8", "c8"],
    ] as const) {
      const requestId = `tools.delegate/${call}`;
      const message = { role: "user" as const, content: [{ type: "text" as const, text: "go" }], timestamp: 0 };
      state.sessions.set(child, {
        info: { id: child, cwd: "/work", parent: { sessionId: "p", toolCallId: call }, createdAt: 1, updatedAt: 1, lastSeq: 2, leaf: `${child}-2` },
        log: [
          { seq: 1, id: `${child}-1`, parent: null, at: 0, data: { type: "turn-start", turnId: "t-before" } },
          { seq: 2, id: `${child}-2`, parent: `${child}-1`, at: 0, data: { type: "message", turnId: "t-before", requestId, message } },
        ],
      });
      await jobFiles(dir).save({ parent: "p", child, prompt: "go", requestId, depth: 1, noticeId: call, title: child });
    }
    const answers = await withCore(
      state,
      Effect.gen(function* () {
        const registries = yield* Registries;
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        const stop = (sessionId: string) => callHere(registries, DelegateChannels.stop, { sessionId });
        return [yield* stop("a7"), yield* stop("a8")];
      }),
      { config: { maxDelegations: 1 } },
    );
    expect(answers).toEqual(["cancelled", "cancelled"]);
    expect(state.cancelled).toEqual(["a7", "a8"]);
    expect(state.deleted).toEqual([]);
  });

  it("keep their file, and tell nothing, when how they ended cannot be read: a restart waits on them again", async () => {
    const state = fresh();
    caller(state);
    const dir = path.join(home, "delegate", "agents");
    const files = await withCore(
      state,
      Effect.gen(function* () {
        yield* call({ prompt: "unreadable", title: "Unread", background: true });
        while (!state.unreadable.has("a1")) yield* Effect.yieldNow;
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
        return yield* Effect.promise(() => jobFiles(dir).all());
      }),
    );
    expect(state.notices).toEqual([]);
    expect(files).toMatchObject([{ child: "a1", title: "Unread" }]);
  });

  it("tell the thread again until it logs the notice: one no agent heard is not lost", async () => {
    const state: State = { ...fresh(), deaf: 1 };
    caller(state);
    await withCore(
      state,
      Effect.gen(function* () {
        yield* call({ prompt: "quick", title: "Quick", background: true });
        while (state.notices.length === 0) {
          yield* TestClock.adjust("15 seconds");
          yield* Effect.yieldNow;
        }
      }),
      { testClock: true },
    );
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatchObject({ sessionId: "p", id: "c1", display: "Quick finished" });
  });
});

describe("the agents section", () => {
  it("lists the modes offered to agents where the request offers the tool, and the thread's agents at work", async () => {
    const state: State = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    caller(state);
    state.modes = [
      { name: "explore", description: "Reads and reports", use: ["agent"], source: "bundled" },
      { name: "creator", use: ["thread"], source: "bundled" },
    ];
    const texts = await withCore(
      state,
      Effect.gen(function* () {
        const without = yield* sectionFor(["read"]);
        yield* call({ prompt: "wait", title: "Long job", background: true });
        const withTool = yield* sectionFor(["delegate"]);
        yield* Deferred.succeed(state.release!, undefined);
        return { without, withTool };
      }),
    );
    expect(texts.without).toBeUndefined();
    expect(texts.withTool).toContain("- explore: Reads and reports");
    expect(texts.withTool).not.toContain("creator");
    expect(texts.withTool).toContain('"Long job" (session a1)');
  });

  it("goes with the tool once a request's tools are chosen, as a mode without it (an explorer) leaves it out", async () => {
    const state = fresh();
    caller(state);
    let keeps = (_: string) => true;
    const mode = definePlugin({
      id: "mode-fake",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(AgentRequestHook, (draft, next) => next({ ...draft, tools: draft.tools.filter((tool) => keeps(tool.spec.name)) }), { phase: "select" }),
        ),
      ),
    });
    const sent = await withCore(
      state,
      Effect.gen(function* () {
        const hooks = yield* Hooks;
        const offered = yield* Effect.flatMap(ToolRunner, (registry) => registry.list);
        const draft: RequestDraft = {
          sessionId: "p",
          turnId: "t",
          cwd: "/work",
          model: "faux/m",
          sections: [
            { id: "tools.delegate.agents", source: "tools.delegate", text: "<agents>…</agents>" },
            { id: "other", source: "other", text: "Other" },
          ],
          tools: offered,
          branch: [],
          history: [],
          append: () => Effect.die("not appended"),
        };
        const ask = (keep: (name: string) => boolean) => {
          keeps = keep;
          return Effect.map(
            hooks.invoke(AgentRequestHook, draft, ({ model, sections, tools }) => Effect.succeed({ model, sections, tools })),
            (plan) => plan.sections.map((section) => section.id),
          );
        };
        return [yield* ask(() => true), yield* ask((name) => name !== "delegate")];
      }),
      { extra: [mode] },
    );
    expect(sent).toEqual([["tools.delegate.agents", "other"], ["other"]]);
  });

  it("goes with the tool at the deepest an agent goes, where the tool is not offered", async () => {
    const state = fresh();
    caller(state);
    const turnStart = (depth?: number): SessionEvent => ({
      seq: 1,
      id: "e1",
      parent: null,
      at: 0,
      data: { type: "turn-start", turnId: "t", ...(depth === undefined ? {} : { plugins: { "tools.delegate": { depth } } }) },
    });
    const sent = await withCore(
      state,
      Effect.gen(function* () {
        const hooks = yield* Hooks;
        const offered = yield* Effect.flatMap(ToolRunner, (registry) => registry.list);
        const ask = (branch: readonly SessionEvent[]) =>
          Effect.map(
            hooks.invoke(
              AgentRequestHook,
              {
                sessionId: "p",
                turnId: "t",
                cwd: "/work",
                model: "faux/m",
                sections: [{ id: "tools.delegate.agents", source: "tools.delegate", text: "<agents>…</agents>" }],
                tools: offered,
                branch,
                history: [],
                append: () => Effect.die("not appended"),
              },
              ({ model, sections, tools }) => Effect.succeed({ model, sections, tools }),
            ),
            (plan) => ({ tools: plan.tools.some((tool) => tool.spec.name === "delegate"), sections: plan.sections.length }),
          );
        return [yield* ask([turnStart()]), yield* ask([turnStart(1)])];
      }),
    );
    // A person's thread hands tasks on; its agent, at the default depth of 1, is not offered the tool.
    expect(sent).toEqual([
      { tools: true, sections: 1 },
      { tools: false, sections: 0 },
    ]);
  });
});

describe("reading logs", () => {
  it("finds a thread's last model and where its finished turns end", () => {
    const state = fresh();
    caller(state);
    const log = state.sessions.get("p")!.log;
    expect(lastTurnOptions(log)).toEqual({ model: "anthropic/opus", thinking: "high" });
    expect(forkPoint(log)).toBe("p-3");
    expect(forkPoint([])).toBeUndefined();
  });
});
