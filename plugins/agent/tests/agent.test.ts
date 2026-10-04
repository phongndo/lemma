import * as fs from "node:fs/promises";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Agent, AgentContinueHook, AgentError, AgentRequestHook, branchOf, emptyUsage, rebuildRequest, Sessions, ToolResult } from "@lemma/contracts";
import type { EventData, LlmRequest, SessionEvent, Tool } from "@lemma/contracts";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";
import { call, failWith, fakeLlm, gated, hang, host, paths, recorder, reply, tempDir, testTools, useTools, waitFor } from "./fakes.ts";
import type { Script } from "./fakes.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Setup {
  readonly scripts: readonly (Script | ((request: LlmRequest) => Script))[];
  readonly plugins?: readonly Plugin[];
  readonly tools?: readonly Tool<any>[];
  readonly config?: Record<string, unknown>;
  readonly models?: readonly string[];
}

const withAgent = <A, E>(
  setup: Setup,
  body: (fixture: {
    readonly requests: LlmRequest[];
    readonly rec: ReturnType<typeof recorder>;
    readonly executed: string[];
  }) => Effect.Effect<A, E, Agent | Sessions | Events>,
) => {
  const llm = fakeLlm(setup.scripts, setup.models);
  const rec = recorder();
  const toolset = testTools(setup.tools);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, toolset.plugin, llm.plugin, agent, rec.plugin, ...(setup.plugins ?? [])], {
          configs: { agent: setup.config ?? {} },
        });
        return yield* core.run(body({ requests: llm.requests, rec, executed: toolset.executed }));
      }),
    ),
  );
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const types = (events: readonly SessionEvent[]) => events.map((event) => event.data.type);
const ofType = <T extends EventData["type"]>(events: readonly SessionEvent[], type: T) =>
  events.flatMap((event) => (event.data.type === type ? [event.data as Extract<EventData, { type: T }>] : []));

const newSession = Effect.flatMap(Sessions, (store) => store.create());
const log = (sessionId: string) => Effect.flatMap(Sessions, (store) => store.events(sessionId));

/** Every `request` event rebuilds to exactly what the model received, in order. */
const expectLogInvariant = (events: readonly SessionEvent[], sessionId: string, requests: readonly LlmRequest[]) => {
  const logged = events.filter((event) => event.data.type === "request");
  expect(logged.length).toBe(requests.length);
  logged.forEach((event, i) => {
    const rebuilt = rebuildRequest(branchOf(events, event.id), event.id, sessionId);
    expect(rebuilt).toEqual(requests[i]);
  });
};

describe("agent", () => {
  it("runs a text-only turn and logs it with timing, title, and usage", async () => {
    await withAgent({ scripts: [reply("Hello there")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("Say   hello\nplease")));
        const events = yield* log(id);
        expect(types(events)).toEqual(["turn-start", "message", "title", "step-start", "request", "message", "step-end", "turn-end"]);
        expect(ofType(events, "title")[0]!.title).toBe("Say hello please");
        const [user, answer] = ofType(events, "message");
        expect(user!.message).toMatchObject({ role: "user", content: text("Say   hello\nplease") });
        expect(answer!.message).toMatchObject({ role: "assistant", content: text("Hello there") });
        const timing = answer!.timing!;
        expect(timing.firstTokenAt).toBeGreaterThanOrEqual(timing.startedAt);
        expect(timing.endedAt).toBeGreaterThanOrEqual(timing.firstTokenAt!);
        expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "done" });
        expect(requests[0]!.model).toBe("fake/m1");
        expect(requests[0]!.messages).toEqual([user!.message]);
        expectLogInvariant(events, id, requests);
        yield* waitFor(
          Effect.sync(() => rec.ended.length),
          (n) => n === 1,
        );
        expect(rec.ended[0]).toMatchObject({ reason: "done", usage: { input: 10, output: 5 } });
        expect(rec.deltas.map((event) => event.type)).toEqual(["start", "text-delta", "text-delta", "done"]);
      }),
    );
  });

  it("loops through tool calls, logging results with details, and keeps the title", async () => {
    await withAgent(
      {
        scripts: [useTools(call("c1", "echo", { text: "one" }), call("c2", "echo", { text: "two" })), reply("Done")],
      },
      ({ requests, executed }) =>
        Effect.gen(function* () {
          const store = yield* Sessions;
          const { id } = yield* newSession;
          yield* store.append(id, { type: "title", title: "Mine" });
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
          const events = yield* log(id);
          expect(executed).toEqual(["one", "two"]);
          expect(ofType(events, "title").map((data) => data.title)).toEqual(["Mine"]);
          const results = ofType(events, "message").filter((data) => data.message.role === "toolResult");
          expect(results.map((data) => [data.message, data.details])).toEqual([
            [expect.objectContaining({ toolCallId: "c1", toolName: "echo", content: text("echo: one"), isError: false }), { length: 3 }],
            [expect.objectContaining({ toolCallId: "c2", content: text("echo: two") }), { length: 3 }],
          ]);
          expect(results[0]!.timing!.endedAt).toBeGreaterThanOrEqual(results[0]!.timing!.startedAt);
          expect(requests).toHaveLength(2);
          expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
          expect(ofType(events, "step-start")).toHaveLength(2);
          expectLogInvariant(events, id, requests);
        }),
    );
  });

  it("answers unknown tools and invalid input with error results the model can read", async () => {
    await withAgent({ scripts: [useTools(call("c1", "nope", {}), call("c2", "echo", { text: 5 })), reply("ok")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        const results = requests[1]!.messages.filter((message) => message.role === "toolResult");
        expect(results.map((message) => message.isError)).toEqual([true, true]);
        expect(JSON.stringify(results[0]!.content)).toContain('Tool \\"nope\\" not found');
        expect(JSON.stringify(results[1]!.content)).toContain("Validation failed");
      }),
    );
  });

  it("records contributions with plugin ids and omits unchanged system and tools", async () => {
    let calls = 0;
    const context = definePlugin({
      id: "project-notes",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(AgentRequestHook, (draft, next) => {
            calls++;
            // The third request (second turn's second step) changes its section.
            const note = calls >= 3 ? "Notes v2" : "Notes v1";
            return next({ ...draft, sections: [...draft.sections, { id: "notes", source: owner.id, text: note }] });
          });
        }),
      ),
    });
    await withAgent(
      {
        plugins: [context],
        scripts: [useTools(call("c1", "echo", { text: "x" })), reply("a"), reply("b")],
      },
      ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const a = yield* Agent;
          yield* a.prompt(id, text("first"));
          yield* a.prompt(id, text("second"));
          const events = yield* log(id);
          const logged = ofType(events, "request");
          expect(logged).toHaveLength(3);
          expect(logged[0]!.contributions).toEqual([
            { source: "agent", kind: "system", label: "base", chars: expect.any(Number) },
            { source: "agent", kind: "system", label: "environment", chars: expect.any(Number) },
            { source: "project-notes", kind: "system", label: "notes", chars: 8 },
            { source: "test-tools", kind: "tool", label: "echo", chars: expect.any(Number) },
          ]);
          expect(logged[0]!.composition).toBe("comp-1");
          expect(logged[0]!.system).toContain("You are an expert coding assistant");
          expect(logged[0]!.system).toContain(`Current working directory: ${dir}`);
          expect(logged[0]!.system!.endsWith("Notes v1")).toBe(true);
          expect(logged[0]!.tools!.map((tool) => tool.name)).toEqual(["echo"]);
          expect(logged[1]!.system).toBeUndefined();
          expect(logged[1]!.tools).toBeUndefined();
          expect(logged[2]!.system!.endsWith("Notes v2")).toBe(true);
          expect(logged[2]!.tools).toBeUndefined();
          expect(requests.map((request) => request.system!.slice(-8))).toEqual(["Notes v1", "Notes v1", "Notes v2"]);
          expect(requests.every((request) => request.tools?.length === 1)).toBe(true);
          expectLogInvariant(events, id, requests);
        }),
    );
  });

  /** A plugin that, before the second turn's request, summarizes everything before its prompt; `after` runs next. */
  const compactor = (after: Effect.Effect<void, AgentError> = Effect.void) =>
    definePlugin({
      id: "compactor",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(AgentRequestHook, (draft, next) =>
            Effect.gen(function* () {
              if (draft.history.length !== 3) return yield* next(draft);
              const prompt = [...draft.branch].reverse().find((event) => event.data.type === "message" && event.data.message.role === "user")!;
              yield* draft.append({
                type: "compaction",
                summary: "They said first.",
                firstKeptId: prompt.id,
                tokensBefore: 10,
                source: owner.id,
                turnId: draft.turnId,
                usage: { ...emptyUsage, input: 7, output: 3, totalTokens: 10 },
              });
              yield* after;
              return yield* next(draft);
            }),
          );
        }),
      ),
    });

  it("continues from events a request handler appends, so a compaction changes what the model sees", async () => {
    await withAgent({ plugins: [compactor()], scripts: [reply("a"), reply("b")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* a.prompt(id, text("first"));
        yield* a.prompt(id, text("second"));
        expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "user"]);
        expect(JSON.stringify(requests[1]!.messages[0])).toContain("They said first.");
        const events = yield* log(id);
        expect(types(events).slice(-6)).toEqual(["step-start", "compaction", "request", "message", "step-end", "turn-end"]);
        expectLogInvariant(events, id, requests);
        // Writing the summary is part of what the turn cost.
        expect(rec.ended.at(-1)!.usage.input).toBe(10 + 7);
      }),
    );
  });

  it("keeps an appended event on the turn's branch when a later handler fails", async () => {
    const failing = Effect.fail(new AgentError({ sessionId: "", reason: "Hook", message: "project context unreadable" }));
    await withAgent({ plugins: [compactor(failing)], scripts: [reply("a")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* a.prompt(id, text("first"));
        yield* Effect.flip(a.prompt(id, text("second")));
        const store = yield* Sessions;
        const branch = yield* store.branch(id);
        expect(types(branch).slice(-4)).toEqual(["step-start", "compaction", "step-end", "turn-end"]);
      }),
    );
  });

  it("cancels mid-stream: logs the partial output as an attempt and ends the turn cancelled", async () => {
    await withAgent({ scripts: [hang("partial "), reply("after")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const turn = yield* Effect.fork(a.prompt(id, text("go")));
        yield* waitFor(
          Effect.sync(() => rec.deltas.length),
          (n) => n >= 2,
        );
        expect(yield* a.running).toEqual([id]);
        yield* a.cancel(id);
        yield* Fiber.join(turn);
        expect(yield* a.busy(id)).toBe(false);
        const events = yield* log(id);
        expect(types(events).slice(-3)).toEqual(["attempt", "step-end", "turn-end"]);
        expect(ofType(events, "attempt")[0]!.message).toMatchObject({ stopReason: "aborted", content: text("partial ") });
        expect(ofType(events, "turn-end")[0]!.reason).toBe("cancelled");
        yield* waitFor(
          Effect.sync(() => rec.ended.map((ended) => ended.reason)),
          (reasons) => reasons[0] === "cancelled",
        );
        // The attempt is not model-visible: the next request sees only the two user prompts.
        yield* a.prompt(id, text("again"));
        expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "user"]);
        expectLogInvariant(yield* log(id), id, requests);
      }),
    );
  });

  it("cancels mid-tool: aborts the tool and answers every unanswered call", async () => {
    let aborted = false;
    const started = Effect.runSync(Deferred.make<void>());
    const slow: Tool<unknown> = {
      name: "slow",
      description: "Waits.",
      input: Schema.Unknown,
      execute: (_, context) =>
        new Promise<ToolResult>((resolve) => {
          Effect.runSync(Deferred.succeed(started, undefined));
          context.signal.addEventListener("abort", () => {
            aborted = true;
            resolve(new ToolResult({ content: text("stopped"), isError: true }));
          });
        }),
    };
    await withAgent(
      {
        tools: [slow],
        scripts: [useTools(call("c1", "echo", { text: "first" }), call("c2", "slow", {}), call("c3", "echo", { text: "never" })), reply("next")],
      },
      ({ requests, executed }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const a = yield* Agent;
          const turn = yield* Effect.fork(a.prompt(id, text("go")));
          yield* Deferred.await(started);
          yield* a.cancel(id);
          yield* Fiber.join(turn);
          expect(aborted).toBe(true);
          expect(executed).toEqual(["first"]);
          const events = yield* log(id);
          const results = ofType(events, "message").flatMap((data) => (data.message.role === "toolResult" ? [data.message] : []));
          expect(results.map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"]);
          expect(results.slice(1).every((message) => message.isError)).toBe(true);
          expect(ofType(events, "turn-end")[0]!.reason).toBe("cancelled");
          expect(types(events).slice(-2)).toEqual(["step-end", "turn-end"]);
          // History stays valid: the next request pairs every tool call with a result.
          yield* a.prompt(id, text("continue"));
          expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "toolResult", "user"]);
        }),
    );
  });

  it("rejects a second prompt with Busy when asked to, and keeps running when the caller goes away", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await withAgent({ scripts: [gated(gate, reply("late"))] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const caller = yield* Effect.fork(a.prompt(id, text("go")));
        yield* waitFor(a.busy(id), (busy) => busy);
        const busy = yield* Effect.flip(a.prompt(id, text("again"), { whenBusy: "reject" }));
        expect(busy.reason).toBe("Busy");
        yield* Fiber.interrupt(caller);
        expect(yield* a.busy(id)).toBe(true);
        yield* Deferred.succeed(gate, undefined);
        yield* waitFor(a.busy(id), (running) => !running);
        yield* waitFor(
          Effect.sync(() => rec.ended.length),
          (n) => n === 1,
        );
        expect(ofType(yield* log(id), "turn-end")[0]!.reason).toBe("done");
      }),
    );
  });

  it("fails with NoModel before logging anything when no model is available or the model is unknown", async () => {
    await withAgent({ scripts: [], models: [] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        expect((yield* Effect.flip(a.prompt(id, text("go")))).reason).toBe("NoModel");
        expect((yield* Effect.flip(a.prompt(id, text("go"), { model: "x/y" }))).reason).toBe("NoModel");
        expect(yield* log(id)).toEqual([]);
      }),
    );
  });

  it("uses the configured default model and system prompt", async () => {
    await withAgent(
      {
        scripts: [reply("hi")],
        models: ["fake/m1", "fake/m2"],
        config: { defaultModel: "fake/m2", systemPrompt: "Custom base." },
      },
      ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go"), { thinking: "high" }));
          expect(requests[0]).toMatchObject({ model: "fake/m2", thinking: "high" });
          expect(requests[0]!.system!.startsWith("Custom base.\n\n<environment>")).toBe(true);
          expect(requests[0]!.system).toContain(`Lemma session: ${id}`);
          expect(requests[0]!.system).not.toContain("Lemma CLI:");
        }),
    );
  });

  it("names the configured CLI in the environment section", async () => {
    await withAgent({ scripts: [reply("hi")], models: ["fake/m1"], config: { cli: "lemma-test" } }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        expect(requests[0]!.system).toContain("Lemma CLI: `lemma-test`");
        expect(requests[0]!.system).toContain(`Lemma session: ${id}`);
      }),
    );
  });

  it("stops at maxSteps and logs a model error as an attempt", async () => {
    await withAgent(
      {
        config: { maxSteps: 2 },
        scripts: [useTools(call("c1", "echo", { text: "a" })), useTools(call("c2", "echo", { text: "b" })), failWith("overloaded")],
      },
      () =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const a = yield* Agent;
          yield* a.prompt(id, text("loop"));
          expect(ofType(yield* log(id), "turn-end")[0]!.reason).toBe("max-steps");
          yield* a.prompt(id, text("again"));
          const events = yield* log(id);
          expect(ofType(events, "attempt")[0]!.message.errorMessage).toBe("overloaded");
          expect(ofType(events, "turn-end")[1]).toMatchObject({ reason: "error", error: "overloaded" });
        }),
    );
  });

  it("lets AgentContinueHook stop a tool loop early", async () => {
    const stopper = definePlugin({
      id: "stopper",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(AgentContinueHook, () => Effect.succeed("stop" as const)))),
    });
    await withAgent({ plugins: [stopper], scripts: [useTools(call("c1", "echo", { text: "a" }))] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        expect(requests).toHaveLength(1);
        expect(ofType(yield* log(id), "turn-end")[0]!.reason).toBe("done");
      }),
    );
  });
});
