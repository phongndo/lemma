import { promises } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin, PluginContext } from "@lemma/core";
import type { Handler } from "@lemma/core";
import { Paths } from "@lemma/contracts";
import { nodeFileSystem } from "@lemma/contracts/fs";
import { Agent, AgentContinueHook, AgentError, AgentInputHook, AgentRequestHook, PromptSections } from "@lemma/agent";
import type { PromptDecision, PromptInput } from "@lemma/agent";
import { emptyUsage, LlmRequest, LlmRequestHook } from "@lemma/llm";
import { branchOf, rebuildRequest, SessionError, SessionRemoveHook, Sessions } from "@lemma/sessions";
import { ToolResult } from "@lemma/tools";
import type { ToolResultMessage } from "@lemma/llm";
import type { EventData, SessionEvent } from "@lemma/sessions";
import type { Tool } from "@lemma/tools";
import sessions from "@lemma/sessions-files";
import { readJournals } from "../src/state.ts";
import { BRANCHED_CALL, unansweredCalls } from "../src/turn.ts";
import { call, failWith, gated, hang, log, newSession, ofType, reply, runAgent, tempDir, text, types, useTools, waitFor } from "./fakes.ts";
import type { AgentSetup } from "./fakes.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const withAgent = <A, E>(setup: AgentSetup, body: Parameters<typeof runAgent<A, E>>[2]) => runAgent(dir, setup, body);

/** A session whose turn the agent left open as it stopped, cut off in its model call, with prompts `queued` behind it. */
const suspendTurn = (queued: readonly string[] = []) =>
  withAgent({ scripts: [hang("thinking")], config: { stopGrace: 0 } }, ({ requests }) =>
    Effect.gen(function* () {
      const { id } = yield* newSession;
      const a = yield* Agent;
      yield* Effect.forkChild(a.prompt(id, text("go")));
      yield* waitFor(
        Effect.sync(() => requests.length),
        (asked) => asked === 1,
      );
      for (const requestId of queued) yield* Effect.forkChild(a.prompt(id, text(requestId), { requestId }));
      yield* waitFor(a.queue(id), (queue) => queue.length === queued.length);
      return id;
    }),
  );

/**
 * Holds up the next `rm` or `rename` through `node:fs`'s promises (as the sessions store and journal writes make
 * them) of a path ending in `suffix`: `reached` once it waits, until `go`.
 */
const holdUpFile = (operation: "rm" | "rename", suffix: string) => {
  let reach = () => {};
  let go = () => {};
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const gate = new Promise<void>((resolve) => (go = resolve));
  const original = promises[operation] as (...args: unknown[]) => Promise<void>;
  const spy = vi.spyOn(promises, operation).mockImplementation((async (...args: unknown[]) => {
    if (String(args[operation === "rm" ? 0 : 1]).endsWith(suffix)) {
      spy.mockRestore();
      reach();
      await gate;
    }
    return original.apply(promises, args);
  }) as never);
  return { reached: Effect.promise(() => reached), go: () => go() };
};

/** Lets every fiber that can run do so, as far as it can without waiting on anything but another's turn. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow;
});

/**
 * The sessions store, but right after a read of where a session's branch ends (`on`: reading the branch, or the
 * session's info and its leaf; `skip` such reads first), the checkout `race.checkout` names is made, as a client's
 * racing the agent would be.
 */
const racingSessions = (race: { checkout?: { readonly sessionId: string; readonly eventId: string }; on?: "branch" | "get"; skip?: number }) =>
  definePlugin({
    id: "sessions",
    provides: [Sessions],
    requires: [Paths],
    exclusive: true,
    layer: Layer.effect(
      Sessions,
      Effect.map(Sessions, (store) => {
        const after = (read: "branch" | "get") => () => {
          const move = race.checkout;
          if (move === undefined || (race.on ?? "branch") !== read) return Effect.void;
          if ((race.skip ?? 0) > 0) {
            race.skip = race.skip! - 1;
            return Effect.void;
          }
          delete race.checkout;
          return Effect.asVoid(store.checkout(move.sessionId, move.eventId));
        };
        return {
          ...store,
          branch: (sessionId: string, options?: { readonly leaf?: string }) => Effect.tap(store.branch(sessionId, options), after("branch")),
          get: (sessionId: string) => Effect.tap(store.get(sessionId), after("get")),
        };
      }),
    ).pipe(Layer.provide(sessions.layer({}) as Layer.Layer<Sessions, never, Paths>)),
  });
/**
 * The sessions store, but the calls `fails` names fail, as an unreadable file's would: `fails.reads(n)` says whether
 * the `n`th log read does (from 1), and so for `get` and `hold`.
 */
const unreadableSessions = (fails: {
  readonly reads?: (n: number) => boolean;
  readonly gets?: (n: number) => boolean;
  readonly holds?: (n: number) => boolean;
}) =>
  definePlugin({
    id: "sessions",
    provides: [Sessions],
    requires: [Paths],
    exclusive: true,
    layer: Layer.effect(
      Sessions,
      Effect.map(Sessions, (store) => {
        const made = { reads: 0, gets: 0, holds: 0 };
        const unless = <A, R>(kind: "reads" | "gets" | "holds", sessionId: string, call: Effect.Effect<A, SessionError, R>) =>
          Effect.suspend(() => {
            made[kind] += 1;
            return fails[kind]?.(made[kind]) === true ? Effect.fail(new SessionError({ sessionId, reason: "Io", message: "unreadable" })) : call;
          });
        return {
          ...store,
          events: (sessionId: string, options?: { readonly after?: number }) => unless("reads", sessionId, store.events(sessionId, options)),
          get: (sessionId: string) => unless("gets", sessionId, store.get(sessionId)),
          hold: (sessionId: string) => unless("holds", sessionId, store.hold(sessionId)),
        };
      }),
    ).pipe(Layer.provide(sessions.layer({}) as Layer.Layer<Sessions, never, Paths>)),
  });

/** The sessions store, but appending a `turn-end` fails while `fails.turnEnd` says so, as a full disk would. */
const unclosableSessions = (fails: { turnEnd: boolean }) =>
  definePlugin({
    id: "sessions",
    provides: [Sessions],
    requires: [Paths],
    exclusive: true,
    layer: Layer.effect(
      Sessions,
      Effect.map(Sessions, (store) => ({
        ...store,
        append: (sessionId: string, data: EventData, options?: { readonly parent?: string }) =>
          data.type === "turn-end" && fails.turnEnd
            ? Effect.fail(new SessionError({ sessionId, reason: "Io", message: "disk full" }))
            : store.append(sessionId, data, options),
      })),
    ).pipe(Layer.provide(sessions.layer({}) as Layer.Layer<Sessions, never, Paths>)),
  });

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

  it("lets a plugin rewrite a prompt (credited in the log), handle it, or refuse it, before it is placed", async () => {
    const seen: string[] = [];
    const input = (id: string, order: number, decide: (text: string) => "rewrite" | "handle" | "refuse" | "pass") =>
      definePlugin({
        id,
        layer: Layer.effectDiscard(
          Effect.flatMap(PluginContext, (owner) =>
            owner.on(
              AgentInputHook,
              (prompt, next) => {
                const said = prompt.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
                seen.push(`${id}:${said}`);
                switch (decide(said)) {
                  case "rewrite":
                    return next({ ...prompt, content: text(said.replace("/hello", "Say hello")) });
                  case "handle":
                    return Effect.succeed({ kind: "handle", message: "pong" } as const);
                  case "refuse":
                    return Effect.succeed({ kind: "refuse", reason: "it names a secret" } as const);
                  default:
                    return next(prompt);
                }
              },
              { order },
            ),
          ),
        ),
      });
    const expand = input("expand", 0, (said) => (said.startsWith("/hello") ? "rewrite" : said === "/ping" ? "handle" : "pass"));
    const guard = input("guard", 1, (said) => (said.includes("secret") ? "refuse" : "pass"));
    await withAgent({ plugins: [expand, guard], scripts: [reply("hello!")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        expect(yield* agent.prompt(id, text("/ping"))).toEqual({ kind: "handled", by: "expand", message: "pong" });
        expect(yield* agent.prompt(id, text("my secret"))).toEqual({ kind: "refused", by: "guard", reason: "it names a secret" });
        // Neither reached the model, or the log.
        expect(requests).toHaveLength(0);
        expect(yield* log(id)).toEqual([]);
        expect(yield* agent.prompt(id, text("/hello world"), { requestId: "r1" })).toEqual({ kind: "placed" });
        const [prompt] = (yield* log(id)).filter((event) => event.data.type === "message");
        expect(prompt!.data).toMatchObject({
          message: { content: text("Say hello world") },
          credit: { handlers: [{ source: "expand", changed: ["content"] }, { source: "guard" }] },
        });
        // Sent again, an exactly-once retry: answered as placed, without asking the plugins again.
        seen.length = 0;
        expect(yield* agent.prompt(id, text("/hello world"), { requestId: "r1" })).toEqual({ kind: "placed" });
        expect(seen).toEqual([]);
        // One a plugin handled is answered the same when retried, and the plugin, which acted already, is not asked
        // again; nor when two calls race.
        const twice = yield* Effect.all([agent.prompt(id, text("/ping"), { requestId: "r2" }), agent.prompt(id, text("/ping"), { requestId: "r2" })], {
          concurrency: "unbounded",
        });
        expect(yield* agent.prompt(id, text("/ping"), { requestId: "r2" })).toEqual({ kind: "handled", by: "expand", message: "pong" });
        expect([twice, seen]).toEqual([
          [
            { kind: "handled", by: "expand", message: "pong" },
            { kind: "handled", by: "expand", message: "pong" },
          ],
          ["expand:/ping"],
        ]);
      }),
    );
  });

  it("names the plugin whose answer to a prompt stands, and places one with the options a handler handed on", async () => {
    const on = (id: string, order: number, handle: Handler<PromptInput, PromptDecision, AgentError, any>) =>
      definePlugin({ id, layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(AgentInputHook, handle, { order }))) });
    // The inner one refuses; the outer one handles it instead (queued for review), and is the one that answered.
    const guard = on("guard", 2, () => Effect.succeed({ kind: "refuse", reason: "not allowed" } as const));
    const reviewer = on("reviewer", 1, (prompt, next) =>
      Effect.map(next(prompt), (made) => (made.kind === "refuse" ? ({ kind: "handle", message: "queued for review" } as const) : made)),
    );
    await withAgent({ plugins: [guard, reviewer], scripts: [] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        expect(yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("deploy")))).toEqual({ kind: "handled", by: "reviewer", message: "queued for review" });
      }),
    );
    // `/fast` asks a smaller model: the turn runs on it.
    const fast = on("fast", 0, (prompt, next) => next({ ...prompt, options: { ...prompt.options, model: "fake/small" } }));
    await withAgent({ plugins: [fast], scripts: [reply("quick")], models: ["fake/m1", "fake/small"] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        expect(yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("/fast hi"), { requestId: "r1" }))).toEqual({ kind: "placed" });
        expect(requests.map((request) => request.model)).toEqual(["fake/small"]);
        const [prompt] = (yield* log(id)).filter((event) => event.data.type === "message");
        expect(prompt!.data).toMatchObject({ requestId: "r1", credit: { handlers: [{ source: "fast", changed: ["options"] }] } });
      }),
    );
  });

  it("ends the turn in error, naming the plugin, when a request handler hands on a request of the wrong shape", async () => {
    // As a plugin written in JavaScript might: TypeScript never saw it.
    const sloppy = definePlugin({
      id: "sloppy",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) => owner.on(AgentRequestHook, (draft, next) => next({ ...draft, sections: "be brief" as never }))),
      ),
    });
    await withAgent({ plugins: [sloppy], scripts: [reply("never sent")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const failed = yield* Effect.flip(Effect.flatMap(Agent, (a) => a.prompt(id, text("go"))));
        expect(failed).toMatchObject({ reason: "Hook" });
        expect(failed.message).toContain('plugin "sloppy"');
        expect(failed.message).toContain("sections must be an array");
        expect(requests).toEqual([]);
        const ended = (yield* log(id)).find((event) => event.data.type === "turn-end")!.data;
        expect(ended).toMatchObject({ reason: "error", error: failed.message });
      }),
    );
  });

  it("refuses a call to a tool the request did not offer", async () => {
    const readOnly = definePlugin({
      id: "read-only",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(AgentRequestHook, (draft, next) => next({ ...draft, tools: draft.tools.filter((tool) => tool.spec.name !== "echo") })),
        ),
      ),
    });
    await withAgent({ plugins: [readOnly], scripts: [useTools(call("c1", "echo", { text: "one" })), reply("ok")] }, ({ requests, executed }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        expect(executed).toEqual([]);
        const [result] = requests[1]!.messages.filter((message) => message.role === "toolResult");
        expect(result!.isError).toBe(true);
        expect(JSON.stringify(result!.content)).toContain('Tool \\"echo\\" not found');
      }),
    );
  });

  describe("a tool only a tool calls (nested)", () => {
    const nested: Tool = {
      name: "nested",
      description: "Only a tool that runs others calls it",
      input: Schema.Struct({}),
      nested: true,
      execute: () => new ToolResult({ content: [{ type: "text", text: "reached" }] }),
    };
    const runner: Tool = {
      name: "runner",
      description: "Runs other tools",
      input: Schema.Struct({}),
      nests: true,
      execute: (_, { offered }) => new ToolResult({ content: [{ type: "text", text: `offered: ${offered?.join(",")}` }] }),
    };
    const resultOf = (requests: readonly LlmRequest[], id: string) =>
      requests.at(-1)!.messages.find((message) => message.role === "toolResult" && message.toolCallId === id) as ToolResultMessage;

    it("is offered to a tool that runs others, never declared to the model, which cannot call it", async () => {
      await withAgent({ tools: [nested, runner], scripts: [useTools(call("c1", "nested", {}), call("c2", "runner", {})), reply("ok")] }, ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
          expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual(["echo", "runner"]);
          const refused = resultOf(requests, "c1");
          expect(refused.isError).toBe(true);
          // The tools named to the model are those it was sent.
          expect(JSON.stringify(refused.content)).toContain('Tool \\"nested\\" not found. Available tools: echo, runner');
          expect(JSON.stringify(resultOf(requests, "c2").content)).toContain("offered: echo,nested,runner");
        }),
      );
    });

    it("is declared to the model when no tool that runs others is offered, as nothing else would call it", async () => {
      await withAgent({ tools: [nested], scripts: [useTools(call("c1", "nested", {})), reply("ok")] }, ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
          expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual(["echo", "nested"]);
          expect([resultOf(requests, "c1").isError, JSON.stringify(resultOf(requests, "c1").content)]).toEqual([false, '[{"type":"text","text":"reached"}]']);
        }),
      );
    });
  });

  it("puts a section added without an order after the agent's base, and takes a section with nothing to say as none", async () => {
    const sections = definePlugin({
      id: "aaa.sections",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          Effect.all([
            owner.add(PromptSections, { id: "aaa.rules", text: () => "Mind the rules." }),
            // A plain-JS section's way of saying nothing.
            owner.add(PromptSections, { id: "aaa.nothing", text: () => null as unknown as undefined }),
          ]),
        ),
      ),
    });
    await withAgent({ plugins: [sections], scripts: [reply("ok")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        const system = requests[0]!.system ?? "";
        // The base opens the prompt, whatever the id of a plugin adding a section without an order.
        expect(system.startsWith("# Harness")).toBe(true);
        expect(system.indexOf("Mind the rules.")).toBeGreaterThan(0);
      }),
    );
  });

  it("logs what a request passed on and how the provider answered, and streams the answer to no client", async () => {
    const options = definePlugin({
      id: "warm",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) => owner.on(AgentRequestHook, (draft, next) => next({ ...draft, providerOptions: { temperature: 0.2 } }))),
      ),
    });
    const answered = Stream.concat(
      Stream.make({
        type: "provider" as const,
        status: 200,
        requestId: "req-7",
        credit: { handlers: [{ source: "tracer", ms: 0.1, changed: ["x-trace"] }] },
      }),
      reply("hi"),
    );
    await withAgent({ plugins: [options], scripts: [answered] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        const events = yield* log(id);
        const [request] = ofType(events, "request");
        expect(request).toMatchObject({ providerOptions: { temperature: 0.2 }, handlers: [{ source: "warm", changed: ["providerOptions"] }] });
        expect(requests[0]!.providerOptions).toEqual({ temperature: 0.2 });
        const logged = events.find((event) => event.data.type === "request")!;
        expect(rebuildRequest(branchOf(events, logged.id), logged.id, id)?.providerOptions).toEqual({ temperature: 0.2 });
        const answer = ofType(events, "message").find((data) => data.message.role === "assistant");
        expect(answer).toMatchObject({
          response: { status: 200, requestId: "req-7" },
          credit: { handlers: [{ source: "tracer", changed: ["x-trace"] }] },
        });
        expect(rec.deltas.map((event) => event.type)).toEqual(["start", "text-delta", "text-delta", "done"]);
      }),
    );
  });

  it("sends the request it logged: routed in AgentRequestHook, it rebuilds from the log; changed in LlmRequestHook, it is not sent", async () => {
    const router = definePlugin({
      id: "router",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(AgentRequestHook, (draft, next) => next(draft.model === "fake/m1" ? { ...draft, model: "fake/m2" } : draft)),
        ),
      ),
    });
    let rewrite = false;
    const rewriter = definePlugin({
      id: "rewriter",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(LlmRequestHook, (request, next) => next(rewrite ? new LlmRequest({ ...request, system: "Something else" }) : request)),
        ),
      ),
    });
    await withAgent({ plugins: [router, rewriter], models: ["fake/m1", "fake/m2"], scripts: [reply("routed"), reply("unsent")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* a.prompt(id, text("first"));
        expect(requests.map((request) => request.model)).toEqual(["fake/m2"]);
        expect(ofType(yield* log(id), "request")[0]).toMatchObject({
          model: "fake/m2",
          handlers: [{ source: "router", changed: ["model fake/m1 → fake/m2"] }],
        });
        expectLogInvariant(yield* log(id), id, requests);
        rewrite = true;
        yield* a.prompt(id, text("second"));
        // The provider was asked nothing more: what the log says was sent is all that was.
        expect(requests).toHaveLength(1);
        const events = yield* log(id);
        const failed = ofType(events, "attempt").at(-1)!;
        expect(failed.message.errorMessage).toContain("rewriter changed the request");
        expect(ofType(events, "turn-end").at(-1)).toMatchObject({ reason: "error" });
        expect(rec.ended.at(-1)!.reason).toBe("error");
        const logged = events.filter((event) => event.data.type === "request");
        expect(rebuildRequest(branchOf(events, logged[0]!.id), logged[0]!.id, id)).toEqual(requests[0]);
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
            { source: "agent.loop", kind: "system", label: "agent.base", chars: expect.any(Number) },
            { source: "agent.loop", kind: "system", label: "agent.environment", chars: expect.any(Number) },
            { source: "project-notes", kind: "system", label: "notes", chars: 8 },
            { source: "test-tools", kind: "tool", label: "echo", chars: expect.any(Number) },
          ]);
          expect(logged[0]!.composition).toBe("comp-1");
          // Who changed the request, and how long it took on its own, is logged with it.
          expect(logged[0]!.handlers).toEqual([{ source: "project-notes", ms: expect.any(Number), changed: ["+section notes"] }]);
          expect(logged[0]!.system).toContain("# Harness");
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
        // The compaction is credited to the handler that appended it.
        expect(ofType(events, "request").at(-1)!.handlers).toEqual([{ source: "compactor", ms: expect.any(Number), changed: ["+compaction"] }]);
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

  it("cancels mid-stream: logs what the reply had written, which the model sees next, and ends the turn cancelled", async () => {
    await withAgent({ scripts: [hang("partial "), reply("after")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const turn = yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(
          Effect.sync(() => rec.deltas.length),
          (n) => n >= 2,
        );
        expect(yield* a.running).toEqual([id]);
        yield* a.cancel(id);
        yield* Fiber.join(turn);
        expect(yield* a.busy(id)).toBe(false);
        const events = yield* log(id);
        expect(types(events).slice(-3)).toEqual(["message", "step-end", "turn-end"]);
        // The log says it was stopped.
        expect(ofType(events, "message").at(-1)!.message).toMatchObject({ role: "assistant", stopReason: "aborted", content: text("partial ") });
        expect(ofType(events, "turn-end")[0]!.reason).toBe("cancelled");
        yield* waitFor(
          Effect.sync(() => rec.ended.map((ended) => ended.reason)),
          (reasons) => reasons[0] === "cancelled",
        );
        // The model sees what the user read of it, as a reply that ended there.
        yield* a.prompt(id, text("again"));
        expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        expect(requests[1]!.messages[1]).toMatchObject({ stopReason: "stop", content: text("partial ") });
        expectLogInvariant(yield* log(id), id, requests);
      }),
    );
  });

  it("keeps a stopped reply for inspection only with keepCancelled off, and with no text to keep", async () => {
    for (const [config, script] of [
      [{ keepCancelled: false }, hang("partial ")],
      [{}, hang("")],
    ] as const) {
      await withAgent({ config, scripts: [script, reply("after")] }, ({ requests, rec }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const a = yield* Agent;
          const turn = yield* Effect.forkChild(a.prompt(id, text("go")));
          yield* waitFor(
            Effect.sync(() => rec.deltas.length + requests.length),
            (n) => n >= 2,
          );
          yield* a.cancel(id);
          yield* Fiber.join(turn);
          expect(types(yield* log(id)).slice(-3)).toEqual(["attempt", "step-end", "turn-end"]);
          yield* a.prompt(id, text("again"));
          expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "user"]);
        }),
      );
    }
  });

  it("cancels a turn whatever becomes of the call that asked: one interrupted while the journal is written still stops the turn", async () => {
    await withAgent({ scripts: [hang("partial ")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const turn = yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(
          Effect.sync(() => requests.length),
          (asked) => asked === 1,
        );
        const writing = holdUpFile("rename", `${id}.json`);
        const cancelling = yield* Effect.forkChild(a.cancel(id));
        yield* writing.reached;
        // The caller goes away while its cancel is being recorded; the cancel goes on.
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(cancelling));
        writing.go();
        yield* Fiber.join(interrupted);
        yield* Fiber.join(turn);
        expect(yield* a.busy(id)).toBe(false);
        expect(ofType(yield* log(id), "turn-end")).toMatchObject([{ reason: "cancelled" }]);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
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
          const turn = yield* Effect.forkChild(a.prompt(id, text("go")));
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

  it("answers the tool calls a checkout left open before the next turn, so the request sent is the one logged", async () => {
    await withAgent({ scripts: [useTools(call("c1", "echo", { text: "one" })), reply("Done"), reply("Again"), reply("More")] }, ({ requests, executed }) =>
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        const first = yield* log(id);
        const asked = first.find((event) => event.data.type === "message" && event.data.message.role === "assistant")!;
        // Back to the answer that called the tool, before its result.
        yield* store.checkout(id, asked.id);
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("instead")));
        const events = yield* log(id);
        expect(executed).toEqual(["one"]);
        const closing = events[first.length]!;
        expect(closing.parent).toBe(asked.id);
        const askedData = asked.data as Extract<EventData, { type: "message" }>;
        expect(closing.data).toMatchObject({
          type: "message",
          turnId: askedData.turnId,
          stepId: askedData.stepId,
          message: { role: "toolResult", toolCallId: "c1", isError: true, content: text(BRANCHED_CALL) },
        });
        expect(events[first.length + 1]!.data.type).toBe("turn-start");
        expect(requests[2]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
        expectLogInvariant(events, id, requests);
        // A turn after one that ended has nothing to answer.
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("more")));
        expect(unansweredCalls(yield* store.branch(id))).toBeUndefined();
      }),
    );
  });

  it("starts a turn after the leaf it checked for unanswered calls, though a checkout moves the leaf meanwhile", async () => {
    // The turn before left the branch, which the next starts from without reading it back, while the session's leaf is
    // still its end: what it checks is that leaf (its second read of the session's info; the first is the turn's own).
    const race: Parameters<typeof racingSessions>[0] = { on: "get", skip: 1 };
    await withAgent(
      { sessions: racingSessions(race), scripts: [useTools(call("c1", "echo", { text: "one" })), reply("Done"), reply("Again")] },
      ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
          const first = yield* log(id);
          const asked = first.find((event) => event.data.type === "message" && event.data.message.role === "assistant")!;
          // Right after the next turn reads where its branch ends, a client checks out the answer that called the tool.
          race.checkout = { sessionId: id, eventId: asked.id };
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("again")));
          expect(race.checkout).toBeUndefined();
          const events = yield* log(id);
          expect(events[first.length]).toMatchObject({ parent: first.at(-1)!.id, data: { type: "turn-start" } });
          expect(requests[2]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
          expectLogInvariant(events, id, requests);
        }),
    );
  });

  it("starts a turn after the leaf of the branch it read, though a checkout moves the leaf meanwhile", async () => {
    // Something else appended since the turn before (a title), so the next reads its branch back from the store.
    const race: Parameters<typeof racingSessions>[0] = { on: "branch" };
    await withAgent(
      { sessions: racingSessions(race), scripts: [useTools(call("c1", "echo", { text: "one" })), reply("Done"), reply("Again")] },
      ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
          yield* Effect.flatMap(Sessions, (store) => store.append(id, { type: "title", title: "renamed" }));
          const first = yield* log(id);
          const asked = first.find((event) => event.data.type === "message" && event.data.message.role === "assistant")!;
          race.checkout = { sessionId: id, eventId: asked.id };
          yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("again")));
          expect(race.checkout).toBeUndefined();
          const events = yield* log(id);
          expect(events[first.length]).toMatchObject({ parent: first.at(-1)!.id, data: { type: "turn-start" } });
          expect(requests[2]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
          expectLogInvariant(events, id, requests);
        }),
    );
  });

  it("fails a prompt whose request id it cannot check, rather than placing it again", async () => {
    const failing = { next: false };
    const next = () => {
      const fails = failing.next;
      failing.next = false;
      return fails;
    };
    // One script: a second turn would fail with "no script left".
    await withAgent({ sessions: unreadableSessions({ reads: next }), scripts: [reply("hi")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* a.prompt(id, text("hello"), { requestId: "r1" });
        // Idle, the session's request ids are dropped; a retry reads them again, and that read fails.
        failing.next = true;
        const unchecked = yield* Effect.flip(a.prompt(id, text("hello"), { requestId: "r1" }));
        expect(unchecked).toMatchObject({ reason: "Session", message: "unreadable" });
        yield* a.prompt(id, text("hello"), { requestId: "r1" });
        expect(ofType(yield* log(id), "turn-start")).toHaveLength(1);
      }),
    );
  });

  it("rejects a second prompt with Busy when asked to, and keeps running when the caller goes away", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await withAgent({ scripts: [gated(gate, reply("late"))] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const caller = yield* Effect.forkChild(a.prompt(id, text("go")));
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

  it("refuses deleting a session while its turn runs; a prompt sent while a deletion's handlers run starts its turn, and the deletion then fails Busy", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const answer = Effect.runSync(Deferred.make<void>());
    // Before the store's own deletion, a handler holds a deletion up until `release`.
    const slowRemoval = definePlugin({
      id: "slow-removal",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(SessionRemoveHook, (input, next) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* next(input);
            }),
          ),
        ).pipe(Effect.orDie),
      ),
    });
    await withAgent({ plugins: [slowRemoval], scripts: [hang("thinking"), gated(answer, reply("done"))] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const store = yield* Sessions;
        const first = yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(
          Effect.sync(() => requests.length),
          (asked) => asked === 1,
        );
        expect(yield* Effect.flip(store.remove(id))).toMatchObject({ reason: "Busy", sessionId: id });
        yield* a.cancel(id);
        yield* Fiber.join(first);

        const removal = yield* Effect.forkChild(store.remove(id));
        yield* Deferred.await(entered);
        // Not deleted yet: a prompt starts a turn, which holds the session.
        const now = yield* Effect.forkChild(a.prompt(id, text("now")));
        yield* waitFor(a.busy(id), (busy) => busy);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Effect.flip(Fiber.join(removal))).toMatchObject({ reason: "Busy", sessionId: id });
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(now);
        expect(ofType(yield* log(id), "turn-end").map((data) => data.reason)).toEqual(["cancelled", "done"]);
      }),
    );
  });

  it("a prompt sent while the store deletes the session waits for the deletion, then fails Session; the session's queue and journal go with it", async () => {
    await withAgent({ scripts: [hang("thinking")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const store = yield* Sessions;
        const first = yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(a.busy(id), (busy) => busy);
        const queued = yield* Effect.forkChild(Effect.flip(a.prompt(id, text("next"))));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        // Cancelled, the turn leaves its follow-up queued for the next prompt.
        yield* a.cancel(id);
        yield* Fiber.join(first);
        expect(yield* a.queue(id)).toHaveLength(1);

        const deleting = holdUpFile("rm", `_${id}.jsonl`);
        const removal = yield* Effect.forkChild(store.remove(id));
        yield* deleting.reached;
        const late = yield* Effect.forkChild(Effect.flip(a.prompt(id, text("too late"))));
        yield* settle;
        const waited = late.pollUnsafe() === undefined;
        deleting.go();
        yield* Fiber.join(removal);
        expect(waited).toBe(true);
        expect(yield* Fiber.join(late)).toMatchObject({ reason: "Session", sessionId: id, message: `Session ${id} does not exist` });
        // Heard removed, the agent drops the session's queue and journal.
        expect(yield* Fiber.join(queued)).toMatchObject({ reason: "Session", sessionId: id, message: `Session ${id} was deleted` });
        expect(yield* a.queue(id)).toEqual([]);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("a prompt waiting for its session's deletion holds up no other session's prompt, and stops at once when interrupted", async () => {
    await withAgent({ scripts: [reply("elsewhere")] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        const store = yield* Sessions;
        const { id } = yield* newSession;
        const { id: other } = yield* newSession;
        const deleting = holdUpFile("rm", `_${id}.jsonl`);
        yield* Effect.gen(function* () {
          const removal = yield* Effect.forkChild(store.remove(id));
          yield* deleting.reached;
          const late = yield* Effect.forkChild(a.prompt(id, text("too late")));
          yield* settle;
          // Another session's prompt is admitted, and its turn runs to its end.
          const elsewhere = yield* Effect.forkChild(a.prompt(other, text("go")));
          yield* waitFor(
            Effect.sync(() => elsewhere.pollUnsafe()),
            (exit) => exit !== undefined,
          );
          yield* Fiber.join(elsewhere);
          // Interrupted, the waiting prompt stops with the deletion still held up.
          yield* Fiber.interrupt(late);
          deleting.go();
          yield* Fiber.join(removal);
        }).pipe(Effect.ensuring(Effect.sync(deleting.go)));
        expect(ofType(yield* log(other), "turn-end").map((data) => data.reason)).toEqual(["done"]);
      }),
    );
  });

  it("keeps a suspended turn and its journal while its session cannot be held or read as it starts, and resumes the turn at a start where it can", async () => {
    const id = await suspendTurn();
    // A prompt meanwhile fails as the store does.
    for (const fails of [{ holds: () => true }, { gets: () => true }, { reads: () => true }]) {
      await withAgent({ sessions: unreadableSessions(fails), scripts: [] }, () =>
        Effect.gen(function* () {
          const a = yield* Agent;
          expect(yield* a.busy(id)).toBe(false);
          expect(yield* Effect.flip(a.prompt(id, text("now")))).toMatchObject({ reason: "Session", sessionId: id, message: "unreadable" });
          expect((yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id)?.turn).toBeDefined();
        }),
      );
    }
    await withAgent({ scripts: [reply("done")] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        yield* waitFor(a.busy(id), (busy) => !busy);
        const events = yield* log(id);
        expect(ofType(events, "turn-start")).toHaveLength(1);
        expect(ofType(events, "turn-end")).toMatchObject([{ reason: "done" }]);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("keeps a turn whose turn-end did not reach the log in its journal, and closes it as it ended before the session's next prompt", async () => {
    const fails = { turnEnd: true };
    await withAgent({ sessions: unclosableSessions(fails), scripts: [reply("first"), reply("second")] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        // Its caller is answered: the turn ended, though the log does not say so yet.
        yield* a.prompt(id, text("go"));
        const [started] = ofType(yield* log(id), "turn-start");
        expect(ofType(yield* log(id), "turn-end")).toEqual([]);
        expect(rec.ended).toEqual([]);
        expect(yield* a.busy(id)).toBe(false);
        const journal = (yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id);
        expect(journal?.turn).toMatchObject({ turnId: started!.turnId, closing: { reason: "done" } });
        fails.turnEnd = false;
        yield* a.prompt(id, text("again"));
        const events = yield* log(id);
        const [, next] = ofType(events, "turn-start");
        // Closed as it ended, asking nothing, before the next turn starts.
        expect(ofType(events, "turn-end")).toMatchObject([
          { turnId: started!.turnId, reason: "done" },
          { turnId: next!.turnId, reason: "done" },
        ]);
        expect(ofType(events, "message").map((data) => data.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
        expect(rec.ended.map((ended) => ended.turnId)).toEqual([started!.turnId, next!.turnId]);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("closes a cancelled turn whose turn-end was lost as cancelled when the agent next starts, and holds the queue it held", async () => {
    const fails = { turnEnd: true };
    const id = await withAgent({ sessions: unclosableSessions(fails), scripts: [hang("partial")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(
          Effect.sync(() => requests.length),
          (asked) => asked === 1,
        );
        // Queued behind it, then the turn is cancelled: cancelled, it holds the queue.
        const queued = yield* Effect.forkChild(a.prompt(id, text("later"), { requestId: "later" }));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        yield* a.cancel(id);
        yield* Fiber.join(first);
        expect(ofType(yield* log(id), "turn-end")).toEqual([]);
        const journal = (yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id);
        expect(journal).toMatchObject({ turn: { closing: { reason: "cancelled" } }, queue: [{ requestId: "later" }], held: true });
        yield* Fiber.interrupt(queued);
        return id;
      }),
    );
    await withAgent({ scripts: [] }, ({ requests }) =>
      Effect.gen(function* () {
        const a = yield* Agent;
        yield* waitFor(log(id), (events) => ofType(events, "turn-end").length === 1);
        expect(ofType(yield* log(id), "turn-end")).toMatchObject([{ reason: "cancelled" }]);
        // The queue it held still waits for the next prompt, and nothing was asked.
        expect((yield* a.queue(id)).map((prompt) => prompt.requestId)).toEqual(["later"]);
        expect(requests).toEqual([]);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => journals.get(id)?.turn === undefined && journals.get(id)?.held === true);
      }),
    );
  });

  it("reads a suspended turn's log once, before it resumes: a read that would fail after that costs the turn nothing", async () => {
    const id = await suspendTurn();
    // Every read of the log after the first fails, until this test reads it.
    const failing = { after: true };
    await withAgent({ sessions: unreadableSessions({ reads: (n) => failing.after && n > 1 }), scripts: [reply("done")] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        yield* waitFor(a.busy(id), (busy) => !busy);
        failing.after = false;
        expect(ofType(yield* log(id), "turn-end")).toMatchObject([{ reason: "done" }]);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("resumes a suspended turn when its session is next prompted, then runs that prompt", async () => {
    const id = await suspendTurn();
    // The store cannot hold the session as the agent starts; by the next prompt it can.
    await withAgent({ sessions: unreadableSessions({ holds: (n) => n === 1 }), scripts: [reply("done"), reply("again")] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        expect(yield* a.busy(id)).toBe(false);
        yield* a.prompt(id, text("next"));
        const events = yield* log(id);
        const [resumed, next] = ofType(events, "turn-start");
        expect(ofType(events, "turn-end")).toMatchObject([
          { turnId: resumed!.turnId, reason: "done" },
          { turnId: next!.turnId, reason: "done" },
        ]);
        expect(ofType(events, "message").map((data) => data.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      }),
    );
  });

  it("cancels a suspended turn without asking the model again: recorded in its journal, it closes as cancelled when it can resume", async () => {
    const id = await suspendTurn();
    await withAgent({ sessions: unreadableSessions({ holds: () => true }), scripts: [] }, ({ requests }) =>
      Effect.gen(function* () {
        yield* Effect.flatMap(Agent, (a) => a.cancel(id));
        expect((yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id)?.turn).toMatchObject({ cancelling: true });
        expect(requests).toHaveLength(0);
      }),
    );
    // No script: a model call would fail the turn.
    await withAgent({ scripts: [] }, ({ requests }) =>
      Effect.gen(function* () {
        const a = yield* Agent;
        yield* waitFor(a.busy(id), (busy) => !busy);
        expect(ofType(yield* log(id), "turn-end")).toMatchObject([{ reason: "cancelled" }]);
        expect(requests).toHaveLength(0);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("cancels a suspended turn at once when its session can be read by then", async () => {
    const id = await suspendTurn();
    await withAgent({ sessions: unreadableSessions({ holds: (n) => n === 1 }), scripts: [] }, ({ requests }) =>
      Effect.gen(function* () {
        yield* Effect.flatMap(Agent, (a) => a.cancel(id));
        expect(ofType(yield* log(id), "turn-end")).toMatchObject([{ reason: "cancelled" }]);
        expect(requests).toHaveLength(0);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("closes a cancelled suspended turn with no model to be had: it asks the model nothing, and names its cut-off call as its request did", async () => {
    const id = await suspendTurn();
    await withAgent({ sessions: unreadableSessions({ holds: () => true }), scripts: [] }, () => Effect.flatMap(Agent, (a) => a.cancel(id)));
    await withAgent({ scripts: [], models: [] }, ({ requests }) =>
      Effect.gen(function* () {
        const a = yield* Agent;
        yield* waitFor(a.busy(id), (busy) => !busy);
        const events = yield* log(id);
        expect(ofType(events, "attempt")).toMatchObject([{ message: { stopReason: "aborted", provider: "fake", model: "m1" } }]);
        expect(ofType(events, "turn-end")).toMatchObject([{ reason: "cancelled" }]);
        expect(requests).toHaveLength(0);
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("checks a restored queue against the log before anything needs a model: a steer placed before a crash leaves it, is not withdrawn, and is placed once", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const journal = (id: string) => path.join(dir, "agent", `${id}.json`);
    let saved = "";
    const id = await withAgent(
      { scripts: [gated(gate, useTools(call("c1", "echo", { text: "one" }))), hang("thinking")], config: { stopGrace: 0 } },
      ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const a = yield* Agent;
          yield* Effect.forkChild(a.prompt(id, text("go")));
          yield* waitFor(
            Effect.sync(() => requests.length),
            (asked) => asked === 1,
          );
          yield* Effect.forkChild(a.prompt(id, text("steer"), { whenBusy: "steer", requestId: "steer-placed" }));
          yield* waitFor(a.queue(id), (queue) => queue.length === 1);
          // The journal with the steer still queued, as a crash just after the steer reached the log leaves it.
          saved = yield* Effect.promise(() => fs.readFile(journal(id), "utf8"));
          yield* Deferred.succeed(gate, undefined);
          // The next step asks the model: the steer is in the log.
          yield* waitFor(
            Effect.sync(() => requests.length),
            (asked) => asked === 2,
          );
          return id;
        }),
    );
    await fs.writeFile(journal(id), saved);
    // No model to resume the turn on: the queue is checked against the log all the same.
    await withAgent({ scripts: [], models: [] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        expect(yield* a.queue(id)).toEqual([]);
        expect(yield* a.withdraw(id, "steer-placed")).toBe(false);
        expect((yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id)?.queue).toEqual([]);
      }),
    );
    await withAgent({ scripts: [reply("done")] }, ({ requests }) =>
      Effect.gen(function* () {
        const a = yield* Agent;
        yield* waitFor(a.busy(id), (busy) => !busy);
        expect(requests[0]!.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([text("go"), text("steer")]);
        expect(ofType(yield* log(id), "turn-end")).toMatchObject([{ reason: "done" }]);
      }),
    );
  });

  it("will not tell a restored session's queue while its log cannot be read: queue, view and withdraw fail rather than guess", async () => {
    const id = await suspendTurn(["q1"]);
    await withAgent({ sessions: unreadableSessions({ reads: () => true }), scripts: [] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        expect(yield* Effect.flip(a.withdraw(id, "q1"))).toMatchObject({ reason: "Session", sessionId: id, message: "unreadable" });
        expect(yield* Effect.flip(a.queue(id))).toMatchObject({ reason: "Session", sessionId: id, message: "unreadable" });
        expect(yield* Effect.flip(a.view(id))).toMatchObject({ reason: "Session", sessionId: id, message: "unreadable" });
        expect((yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id)?.queue).toMatchObject([{ requestId: "q1" }]);
      }),
    );
  });

  it("shows a suspended session's queue, not running, and withdraws from it; deleting the session drops the turn", async () => {
    const id = await suspendTurn(["q1"]);
    await withAgent({ sessions: unreadableSessions({ holds: () => true }), scripts: [] }, () =>
      Effect.gen(function* () {
        const a = yield* Agent;
        expect(yield* a.busy(id)).toBe(false);
        expect(yield* a.running).toEqual([]);
        expect((yield* a.view(id)).turnId).toBeUndefined();
        expect((yield* a.queue(id)).map((prompt) => prompt.requestId)).toEqual(["q1"]);
        expect(yield* a.withdraw(id, "q1")).toBe(true);
        expect(yield* a.queue(id)).toEqual([]);
        expect((yield* readJournals({ home: dir, fs: nodeFileSystem })).get(id)).toMatchObject({ turn: { prompts: [expect.anything()] }, queue: [] });
        // Nothing holds the session for a suspended turn.
        yield* Effect.flatMap(Sessions, (store) => store.remove(id));
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(id));
      }),
    );
  });

  it("hears every deletion, however many come while it is busy: each deleted session's queue and journal go", async () => {
    await withAgent({ scripts: [hang("thinking"), reply("ok")] }, ({ requests }) =>
      Effect.gen(function* () {
        const a = yield* Agent;
        const store = yield* Sessions;
        // A session whose prompt waits in the queue after its turn was cancelled.
        const { id: queuedIn } = yield* newSession;
        const first = yield* Effect.forkChild(a.prompt(queuedIn, text("go")));
        yield* waitFor(
          Effect.sync(() => requests.length),
          (asked) => asked === 1,
        );
        const queued = yield* Effect.forkChild(Effect.flip(a.prompt(queuedIn, text("next"))));
        yield* waitFor(a.queue(queuedIn), (queue) => queue.length === 1);
        yield* a.cancel(queuedIn);
        yield* Fiber.join(first);
        const { id: taken } = yield* newSession;
        const many = yield* Effect.forEach(Array.from({ length: 1100 }), () => newSession, { concurrency: 64 });

        // The agent busy writing another session's journal, held up meanwhile.
        const { id: busyIn } = yield* newSession;
        const writing = holdUpFile("rename", `${busyIn}.json`);
        const busy = yield* Effect.forkChild(a.prompt(busyIn, text("go")));
        yield* writing.reached;
        // It hears the first deletion and waits; the queued session's comes next, then more than it has room for.
        yield* store.remove(taken);
        yield* store.remove(queuedIn);
        const rest = yield* Effect.forkChild(Effect.forEach(many, ({ id }) => store.remove(id), { concurrency: "unbounded", discard: true }));
        yield* waitFor(store.list(), (left) => left.length === 1);
        writing.go();
        yield* Fiber.join(rest);
        yield* Fiber.join(busy);

        yield* waitFor(
          Effect.sync(() => queued.pollUnsafe()),
          (exit) => exit !== undefined,
        );
        expect(yield* Fiber.join(queued)).toMatchObject({ reason: "Session", sessionId: queuedIn, message: `Session ${queuedIn} was deleted` });
        yield* waitFor(readJournals({ home: dir, fs: nodeFileSystem }), (journals) => !journals.has(queuedIn));
      }),
    );
  }, 30_000);

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
          expect(requests[0]!.system).toMatch(/^You are .*fake\/m2\)?, running in Lemma, a coding-agent harness\./m);
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

  it("logs the continue decision as the default saw it, and credits a handler that changed what it passed on", async () => {
    // Hands on the answer as if the model had stopped: the default stops, and says why by what it was handed.
    const rewriter = definePlugin({
      id: "rewriter",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(AgentContinueHook, (input, next) => next({ ...input, message: { ...input.message, stopReason: "stop" }, results: [] })),
        ),
      ),
    });
    await withAgent({ plugins: [rewriter], scripts: [useTools(call("c1", "echo", { text: "a" }))] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("go")));
        expect(ofType(yield* log(id), "step-end")[0]!.decision).toEqual({
          result: "stop",
          why: "the model stopped (stop)",
          handlers: [{ source: "rewriter", ms: expect.any(Number), changed: ["input"] }],
        });
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
