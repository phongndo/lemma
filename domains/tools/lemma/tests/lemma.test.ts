import { Context, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { definePlugin, makeCore, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Channels, HostError, Interaction, InteractionError, optionalPayload, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { AgentChannels, AgentError } from "@lemma/agent";
import type { PromptOutcome } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import { SessionChannels, SessionError } from "@lemma/sessions";
import type { EventData, SessionEvent, SessionInfo } from "@lemma/sessions";
import { ToolInvocation, ToolNamespaces, ToolRunner, Tools } from "@lemma/tools";
import type { ToolContribution, ToolResult } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import tools from "@lemma/tools-registry";
import lemma, { depthOf } from "../src/index.ts";
import { failure } from "../src/channels.ts";

/** Adds a channel while the core runs, returning its removal: a plugin coming and going. */
class Served extends Context.Service<Served, { readonly add: (channel: Channel) => Effect.Effect<Effect.Effect<void>> }>()("test/Served") {}

const served = definePlugin({
  id: "served",
  provides: { served: Served },
  setup: (_, owner) => Effect.succeed({ served: { add: (channel: Channel) => Effect.orDie(owner.add(Channels, channel)) } }),
});

/** Answers each confirmation with the next answer (`undefined`: nobody is there), recording what was asked. */
const answers = (queue: (boolean | undefined)[], asked: { title: string; detail?: string }[] = []) =>
  definePlugin({
    id: "answers",
    provides: [Interaction],
    layer: Layer.succeed(Interaction, {
      confirm: (title, detail) =>
        Effect.suspend(() => {
          asked.push({ title, ...(detail === undefined ? {} : { detail }) });
          const next = queue.shift();
          return next === undefined ? Effect.fail(new InteractionError({ reason: "Unavailable", message: "No client is attached" })) : Effect.succeed(next);
        }),
      ask: () => Effect.die("not asked"),
      select: () => Effect.die("not asked"),
      form: () => Effect.die("not asked"),
    }),
  });

type Setup = {
  readonly plugins?: readonly Plugin[];
  readonly config?: Record<string, unknown>;
  readonly answers?: (boolean | undefined)[];
  readonly asked?: { title: string; detail?: string }[];
};

/** Runs `body` with the registry, this plugin, and `Served`, in a core configured with `config`. */
const withCore = <A, E>(setup: Setup, body: Effect.Effect<A, E, ToolRunner | Registries | Served>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, answers(setup.answers ?? [], setup.asked), served, lemma, ...(setup.plugins ?? [])], {
          configs: { "tools.lemma": setup.config ?? {} },
        });
        return yield* core.run(body);
      }),
    ),
  );

/** The tools listed, once `ready` holds of them: the plugin adds them as the channels it hears of arrive. */
const toolsWhen = (ready: (tools: readonly ToolContribution[]) => boolean) =>
  Effect.gen(function* () {
    const registries = yield* Registries;
    const runner = yield* ToolRunner;
    yield* Stream.runHead(Stream.filterEffect(registries.changes(Tools), () => Effect.map(runner.list, ready)));
    return yield* runner.list;
  });
const named = (name: string) => (list: readonly ToolContribution[]) => list.some((tool) => tool.spec.name === name);

const call = (name: string, input: unknown, sessionId = "s", signal = new AbortController().signal) =>
  Effect.flatMap(ToolRunner, (runner) => runner.execute(new ToolInvocation({ sessionId, toolCallId: "c", name, input, cwd: "/work" }), signal));

const listSessions = (handled: unknown[] = []) =>
  serveChannel(
    {
      kind: "call",
      id: "sessions.list",
      title: "List sessions",
      payload: optionalPayload({ cwd: Schema.optional(Schema.String) }),
      success: Schema.Array(Schema.Struct({ id: Schema.String, at: Schema.Date })),
      repeatable: true,
      access: "read",
    },
    (payload) => {
      handled.push(payload);
      return [{ id: "a", at: new Date(0) }];
    },
  );

describe("channels as tools", () => {
  it("offers the allowed ones as nested tools in the lemma namespace, and follows them as they come and go", async () => {
    const seen = await withCore(
      {},
      Effect.gen(function* () {
        const { add } = yield* Served;
        const removeList = yield* add(listSessions());
        // Never offered, however configured; and not configured.
        yield* add(serveChannel({ kind: "call", id: "llm.login", payload: Schema.Void, success: Schema.Void }, () => undefined));
        yield* add(serveChannel({ kind: "call", id: "ticker.price", payload: Schema.Void, success: Schema.Number }, () => 1));
        const listed = yield* toolsWhen(named("lemma_sessions_list"));
        const namespaces = yield* Effect.flatMap(Registries, (registries) => registries.items(ToolNamespaces));
        yield* removeList;
        const after = yield* toolsWhen((list) => !named("lemma_sessions_list")(list));
        return { listed, after, namespaces: namespaces.map(({ item }) => item.name) };
      }),
    );
    const tool = seen.listed.find((candidate) => candidate.spec.name === "lemma_sessions_list")!;
    expect(tool).toMatchObject({ nested: true, namespace: "lemma", replay: "safe" });
    // The payload's JSON form: an optional field may be null there, as a client may send it.
    expect(tool.spec.parameters).toMatchObject({ type: "object", properties: { cwd: { anyOf: [{ type: "string" }, { type: "null" }] } } });
    expect(tool.output).toMatchObject({ type: "array" });
    expect(seen.listed.map((candidate) => candidate.spec.name)).not.toContain("lemma_llm_login");
    expect(seen.listed.map((candidate) => candidate.spec.name)).not.toContain("lemma_ticker_price");
    expect(seen.listed.map((candidate) => candidate.spec.name)).toContain("lemma_delegate");
    expect(seen.after.map((candidate) => candidate.spec.name)).not.toContain("lemma_sessions_list");
    expect(seen.namespaces).toEqual(["lemma"]);
  });

  const declared = (id: string, access?: "read" | "operate" | "change" | "secret") =>
    serveChannel({ kind: "call", id, ...(access === undefined ? {} : { access }), payload: Schema.Void, success: Schema.Number }, () => 1);
  const offered = (config: Record<string, unknown>, ready: readonly string[]) =>
    withCore(
      { config },
      Effect.gen(function* () {
        const { add } = yield* Served;
        for (const channel of [
          declared("test.read", "read"),
          declared("test.operate", "operate"),
          declared("test.change", "change"),
          declared("test.secret", "secret"),
          declared("test.undeclared"),
          declared("test.unlisted"),
        ])
          yield* add(channel);
        const listed = yield* toolsWhen((list) => ready.every((name) => named(name)(list)));
        return new Map(listed.filter((tool) => tool.spec.name.startsWith("lemma_test_")).map((tool) => [tool.spec.name, tool.spec.description]));
      }),
    );
  const asks = (description: string | undefined) => description?.includes("asks the person first");

  it("offers by what a channel declares: every read freely, a secret never, and anything else only as configured", async () => {
    const tools = await offered({ channels: ["*", "test.secret", "test.undeclared"], confirm: ["test.change"] }, [
      "lemma_test_read",
      "lemma_test_change",
      "lemma_test_undeclared",
    ]);
    // A write the config does not name, a secret the config names, and a channel that says nothing it does not name.
    expect([...tools.keys()].sort()).toEqual(["lemma_test_change", "lemma_test_read", "lemma_test_undeclared"]);
    expect(asks(tools.get("lemma_test_change"))).toBe(true);
    expect(asks(tools.get("lemma_test_read"))).toBe(false);
  });

  it("keeps channels an allowlist: without * a read it does not name is not offered, and a write it names asks all the same", async () => {
    const tools = await offered({ channels: ["test.operate", "test.undeclared"], confirm: [] }, ["lemma_test_operate", "lemma_test_undeclared"]);
    expect([...tools.keys()].sort()).toEqual(["lemma_test_operate", "lemma_test_undeclared"]);
    expect(asks(tools.get("lemma_test_operate"))).toBe(true);
    expect(asks(tools.get("lemma_test_undeclared"))).toBe(false);
  });

  it("calls with the payload's JSON and resolves to the result's JSON", async () => {
    const handled: unknown[] = [];
    const result = await withCore(
      { config: { channels: ["sessions.list", "agent.running", "test.echo"] } },
      Effect.gen(function* () {
        const { add } = yield* Served;
        yield* add(listSessions(handled));
        yield* add(serveChannel({ kind: "call", id: "agent.running", payload: Schema.Void, success: Schema.Array(Schema.String) }, () => ["s1"]));
        yield* add(serveChannel({ kind: "call", id: "test.echo", payload: Schema.String, success: Schema.String }, (text) => `${text}!`));
        yield* toolsWhen((list) => ["lemma_sessions_list", "lemma_agent_running", "lemma_test_echo"].every((name) => named(name)(list)));
        return {
          list: yield* call("lemma_sessions_list", { cwd: "/work" }),
          running: yield* call("lemma_agent_running", {}),
          echo: yield* call("lemma_test_echo", { payload: "hi" }),
          wrong: yield* call("lemma_test_echo", { payload: 3 }),
        };
      }),
    );
    expect(handled).toEqual([{ cwd: "/work" }]);
    // A Date crosses as its JSON, as it would to a client.
    expect(result.list.structured).toEqual([{ id: "a", at: "1970-01-01T00:00:00.000Z" }]);
    expect(JSON.parse(textOf(result.list))).toEqual([{ id: "a", at: "1970-01-01T00:00:00.000Z" }]);
    expect(result.running.structured).toEqual(["s1"]);
    expect(result.echo.structured).toBe("hi!");
    expect(result.wrong.isError).toBe(true);
    expect(textOf(result.wrong)).toContain("Validation failed");
  });

  it("names the channel and its code when a call fails, and says what to do", async () => {
    const result = await withCore(
      { config: { channels: ["sessions.get"] } },
      Effect.gen(function* () {
        const { add } = yield* Served;
        yield* add(
          serveChannel({ kind: "call", id: "sessions.get", payload: Schema.Struct({ sessionId: Schema.String }), success: Schema.String }, ({ sessionId }) =>
            Effect.fail(new HostError({ code: "NotFound", subject: sessionId, message: `No session ${sessionId}` })),
          ),
        );
        yield* toolsWhen(named("lemma_sessions_get"));
        return yield* call("lemma_sessions_get", { sessionId: "gone" });
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('"sessions.get" failed (NotFound): No session gone.');
  });

  it("ends a failure's message as a sentence, so the hint after it reads as its own", () => {
    expect(failure("qa.count", new HostError({ code: "Withdrawn", subject: "qa.count", message: '"qa.count" was withdrawn while it was open' }))).toBe(
      '"qa.count" failed (Withdrawn): "qa.count" was withdrawn while it was open. Call again once its plugin is back.',
    );
    expect(failure("ticker.price", new HostError({ code: "NotFound", subject: "ticker.price", message: 'No channel "ticker.price"' }))).toBe(
      '"ticker.price" failed (NotFound): No channel "ticker.price". Its plugin may be off; find what is there with searchTools(\'lemma\').',
    );
  });

  it("leaves out a channel whose payload is a type no JSON decodes to, and offers the rest", async () => {
    const listed = await withCore(
      { config: { channels: ["test.map", "agent.running"] } },
      Effect.gen(function* () {
        const { add } = yield* Served;
        yield* add(
          serveChannel(
            { kind: "call", id: "test.map", payload: Schema.declare((value): value is Map<string, string> => value instanceof Map), success: Schema.Number },
            () => 1,
          ),
        );
        yield* add(serveChannel({ kind: "call", id: "agent.running", payload: Schema.Void, success: Schema.Array(Schema.String) }, () => []));
        return yield* toolsWhen(named("lemma_agent_running"));
      }),
    );
    expect(listed.map((tool) => tool.spec.name)).not.toContain("lemma_test_map");
  });

  it("asks before a call that changes something: declined, or nobody there, is an error, and nothing is called", async () => {
    const asked: { title: string; detail?: string }[] = [];
    const titled: string[] = [];
    const results = await withCore(
      { answers: [false, undefined, true], asked },
      Effect.gen(function* () {
        const { add } = yield* Served;
        yield* add(
          serveChannel(
            {
              kind: "call",
              id: "sessions.set-title",
              title: "Rename a session",
              payload: Schema.Struct({ sessionId: Schema.String, title: Schema.String }),
              success: Schema.String,
            },
            ({ title }) => {
              titled.push(title);
              return title;
            },
          ),
        );
        yield* toolsWhen(named("lemma_sessions_set_title"));
        const input = { sessionId: "s1", title: "Better" };
        return [yield* call("lemma_sessions_set_title", input), yield* call("lemma_sessions_set_title", input), yield* call("lemma_sessions_set_title", input)];
      }),
    );
    expect(asked).toHaveLength(3);
    expect(asked[0]!.title).toBe("Let the agent rename a session (sessions.set-title)?");
    expect(JSON.parse(asked[0]!.detail!)).toEqual({ sessionId: "s1", title: "Better" });
    expect(textOf(results[0]!)).toBe('"sessions.set-title" was not called: The person declined it.');
    expect(textOf(results[1]!)).toContain("Nobody could approve it");
    expect(results[2]!.structured).toBe("Better");
    expect(titled).toEqual(["Better"]);
  });
});

describe("a stream as a tool", () => {
  const numbers = (stream: Stream.Stream<number>) =>
    serveChannel({ kind: "stream", id: "sessions.changes", access: "read", payload: Schema.Void, success: Schema.Number }, () => stream);

  it("collects elements until `take` have come, or the stream ends", async () => {
    const results = await withCore(
      {},
      Effect.gen(function* () {
        const { add } = yield* Served;
        yield* add(numbers(Stream.make(1, 2, 3)));
        yield* toolsWhen(named("lemma_sessions_changes"));
        return [yield* call("lemma_sessions_changes", { take: 2 }), yield* call("lemma_sessions_changes", { take: 10 })];
      }),
    );
    expect(results[0]!.structured).toEqual({ elements: [1, 2], ended: false, timedOut: false });
    expect(results[1]!.structured).toEqual({ elements: [1, 2, 3], ended: true, timedOut: false });
  });

  it("returns what came once `timeoutMs` passes", async () => {
    const result = await withCore(
      {},
      Effect.gen(function* () {
        const opened = yield* Deferred.make<void>();
        const { add } = yield* Served;
        yield* add(numbers(Stream.concat(Stream.make(7), Stream.fromEffect(Effect.andThen(Deferred.succeed(opened, undefined), Effect.never)))));
        yield* toolsWhen(named("lemma_sessions_changes"));
        const fiber = yield* Effect.forkChild(call("lemma_sessions_changes", { take: 5, timeoutMs: 1_000 }));
        yield* Deferred.await(opened);
        // The clock moves until the wait has seen it: the timer may be set a moment after the stream opens.
        while (fiber.pollUnsafe() === undefined) {
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
        }
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.structured).toEqual({ elements: [7], ended: false, timedOut: true });
  });
});

describe("delegation", () => {
  /** A fake agent and sessions store: a prompt makes a turn that answers with what the prompt asks for, or hangs on "hang". */
  const fakes = (state: {
    requests: string[];
    cancelled: string[];
    titles: Record<string, string>;
    logs: Map<string, SessionEvent[]>;
    deleted?: string[];
    busy?: number;
    release?: Deferred.Deferred<void>;
  }) => {
    const info = (sessionId: string): SessionInfo => {
      const log = state.logs.get(sessionId) ?? [];
      return { id: sessionId, cwd: "/work", createdAt: 0, updatedAt: 0, lastSeq: log.length, ...(log.length === 0 ? {} : { leaf: log.at(-1)!.id }) };
    };
    const append = (sessionId: string, data: EventData) => {
      const log = state.logs.get(sessionId)!;
      log.push({ seq: log.length + 1, id: `${sessionId}-${log.length + 1}`, parent: log.at(-1)?.id ?? null, at: log.length, data });
    };
    let made = 0;
    return definePlugin({
      id: "fakes",
      requires: { runner: ToolRunner },
      setup: function* ({ runner }, owner) {
        const channels: Channel[] = [
          serveChannel(SessionChannels.create, () => {
            const id = `d${++made}`;
            state.logs.set(id, []);
            return info(id);
          }),
          serveChannel(SessionChannels.setTitle, ({ sessionId, title }) => {
            state.titles[sessionId] = title;
            return info(sessionId);
          }),
          serveChannel(SessionChannels.get, ({ sessionId }) =>
            state.logs.has(sessionId) ? info(sessionId) : Effect.fail(new HostError({ code: "NotFound", subject: sessionId, message: "No such session" })),
          ),
          // As the sessions store fails it in the host: its own error, not the transport's.
          serveChannel(SessionChannels.events, ({ sessionId }) =>
            state.logs.has(sessionId)
              ? (state.logs.get(sessionId) ?? [])
              : Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: `Session ${sessionId} does not exist` })),
          ),
          // Busy at first, as the store is while the agent settles a refused prompt.
          serveChannel(SessionChannels.delete, ({ sessionId }) => {
            if (state.busy !== undefined && state.busy > 0) {
              state.busy--;
              return Effect.fail(new SessionError({ sessionId, reason: "Busy", message: "This session is in use" }));
            }
            state.logs.delete(sessionId);
            state.deleted?.push(sessionId);
            return Effect.void;
          }),
          serveChannel(AgentChannels.cancel, ({ sessionId }) => void state.cancelled.push(sessionId)),
          serveChannel(AgentChannels.prompt, ({ sessionId, content, requestId }) =>
            Effect.gen(function* (): Effect.fn.Return<PromptOutcome, AgentError> {
              const text = content[0]?.type === "text" ? content[0].text : "";
              // Refused before it is placed, as the agent refuses a prompt for a model it does not know.
              if (text === "refuse") return yield* new AgentError({ sessionId, reason: "NoModel", message: "Unknown model: mock/nope" });
              state.requests.push(requestId);
              const turnId = `t-${sessionId}`;
              append(sessionId, { type: "turn-start", turnId });
              append(sessionId, { type: "message", turnId, requestId, message: { role: "user", content: [...content], timestamp: 0 } });
              if (text === "hang") yield* Effect.never;
              if (text === "wait") yield* Deferred.await(state.release!);
              // The delegate delegates in turn, as its own turn's tool call would, and answers once that ends.
              const inner = text.startsWith("delegate: ")
                ? yield* runner
                    .execute(
                      new ToolInvocation({ sessionId, toolCallId: `in-${sessionId}`, name: "lemma_delegate", input: { prompt: text.slice(10) }, cwd: "/work" }),
                      new AbortController().signal,
                    )
                    .pipe(Effect.orDie)
                : undefined;
              append(sessionId, { type: "step-start", turnId, stepId: "p1" });
              const message = {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: inner === undefined ? `did: ${text}` : `did: ${(inner.structured as { answer: string }).answer}` }],
                api: "x",
                provider: "p",
                model: "m",
                usage: emptyUsage,
                stopReason: "stop" as const,
                timestamp: 0,
              };
              append(sessionId, { type: "message", turnId, stepId: "p1", message });
              append(sessionId, { type: "step-end", turnId, stepId: "p1" });
              append(sessionId, { type: "turn-end", turnId, reason: "done" });
              return { kind: "placed" };
            }),
          ),
        ];
        for (const channel of channels) yield* owner.add(Channels, channel);
      },
    });
  };
  const fresh = () => ({ requests: [] as string[], cancelled: [] as string[], titles: {} as Record<string, string>, logs: new Map<string, SessionEvent[]>() });

  it("starts a session with the prompt, waits for its turn, and resolves to its answer", async () => {
    const state = fresh();
    const result = await withCore({ plugins: [fakes(state)] }, call("lemma_delegate", { prompt: "Sum the numbers\nin data.csv" }));
    expect(result.isError).toBeUndefined();
    expect(result.structured).toEqual({ sessionId: "d1", ended: "done", answer: "did: Sum the numbers\nin data.csv" });
    expect(state.titles).toEqual({ d1: "Sum the numbers" });
    expect(state.requests[0]).toMatch(/^tools\.lemma\/delegate\/1\//);
  });

  it("is at the top for a caller the sessions store does not know", async () => {
    const state = fresh();
    const result = await withCore({ plugins: [fakes(state)] }, call("lemma_delegate", { prompt: "from a script" }, "unknown-caller"));
    expect(result.structured).toMatchObject({ sessionId: "d1", ended: "done" });
    expect(state.requests[0]).toMatch(/^tools\.lemma\/delegate\/1\//);
  });

  it("leaves no session behind when the agent refuses the prompt", async () => {
    const state = { ...fresh(), deleted: [] as string[], busy: 2 };
    const result = await withCore({ plugins: [fakes(state)] }, call("lemma_delegate", { prompt: "refuse" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('No session was started: "agent.prompt" failed (NoModel): Unknown model: mock/nope.');
    expect(state.deleted).toEqual(["d1"]);
    expect(state.logs.size).toBe(0);
  });

  it("refuses a cwd that is not a directory, before making a session", async () => {
    const state = fresh();
    const result = await withCore({ plugins: [fakes(state)] }, call("lemma_delegate", { prompt: "go", cwd: "/definitely/not/here" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("No session was started: /definitely/not/here is not a directory on this host.");
    expect(state.logs.size).toBe(0);
  });

  it("counts depth from the caller's log, and refuses past the deepest", async () => {
    const state = fresh();
    state.logs.set("deep", []);
    const result = await withCore(
      { plugins: [fakes(state)] },
      Effect.gen(function* () {
        const outer = yield* call("lemma_delegate", { prompt: "go deeper" });
        const sessionId = (outer.structured as { sessionId: string }).sessionId;
        // The delegate delegates in turn: one level further down.
        const inner = yield* call("lemma_delegate", { prompt: "and deeper" }, sessionId);
        const innerId = (inner.structured as { sessionId: string }).sessionId;
        return { inner, refused: yield* call("lemma_delegate", { prompt: "too deep" }, innerId) };
      }),
    );
    expect(state.requests.map((id) => id.split("/")[2])).toEqual(["1", "2"]);
    expect(depthOf(state.logs.get("d2")!)).toBe(2);
    expect(result.refused.isError).toBe(true);
    expect(textOf(result.refused)).toContain("2 levels deep");
  });

  it("cancels the turn when it takes longer than timeoutMs", async () => {
    const state = fresh();
    const result = await withCore(
      { plugins: [fakes(state)] },
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(call("lemma_delegate", { prompt: "hang", timeoutMs: 5_000 }));
        while (fiber.pollUnsafe() === undefined) {
          yield* TestClock.adjust("5 seconds");
          yield* Effect.yieldNow;
        }
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.isError).toBe(true);
    expect(result.structured).toMatchObject({ sessionId: "d1", ended: "timeout" });
    expect(state.cancelled).toEqual(["d1"]);
  });

  it("cancels the turn when the call is cancelled", async () => {
    const state = fresh();
    const controller = new AbortController();
    await withCore(
      { plugins: [fakes(state)] },
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(call("lemma_delegate", { prompt: "hang" }, "s", controller.signal)));
        // Aborted once the turn has its prompt.
        while (state.requests.length === 0) yield* Effect.yieldNow;
        controller.abort();
        yield* Fiber.join(fiber);
      }),
    );
    expect(state.cancelled).toEqual(["d1"]);
  });

  it("runs at most maxDelegations at once; the rest wait for one to end", async () => {
    const state = { ...fresh(), release: Effect.runSync(Deferred.make<void>()) };
    const results = await withCore(
      { plugins: [fakes(state)], config: { maxDelegations: 1 } },
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(call("lemma_delegate", { prompt: "wait" }));
        while (state.requests.length === 0) yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(call("lemma_delegate", { prompt: "quick" }));
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        // The second has not started a session while the first runs.
        const startedMeanwhile = state.logs.size;
        yield* Deferred.succeed(state.release, undefined);
        const done: ToolResult[] = [yield* Fiber.join(first), yield* Fiber.join(second)];
        return { startedMeanwhile, done };
      }),
    );
    expect(results.startedMeanwhile).toBe(1);
    expect(results.done.map((result) => (result.structured as { answer: string }).answer)).toEqual(["did: wait", "did: quick"]);
  });

  it("counts each depth's delegations apart, so a delegate waiting on its own does not hold up theirs", async () => {
    const state = fresh();
    const results = await withCore(
      { plugins: [fakes(state)], config: { maxDelegations: 1 } },
      Effect.all([call("lemma_delegate", { prompt: "delegate: one" }), call("lemma_delegate", { prompt: "delegate: two" })], { concurrency: "unbounded" }).pipe(
        Effect.timeout("4 seconds"),
      ),
    );
    expect(results.map((result) => (result.structured as { answer: string }).answer)).toEqual(["did: did: one", "did: did: two"]);
  });
});
