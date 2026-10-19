/*
 * `@lemma/agent/testing`: the `Agent` contract as a Vitest suite, which a plugin replacing `agent.loop` runs to meet the
 * same bar (`agentConformance`). It drives the agent only through `Agent`, the hooks, the events, and the session log,
 * never a provider's internals, and checks what every client and plugin relies on: prompts placed once, requests that
 * rebuild from the log, tool calls run once and answered, the busy rules, cancellation, and the hooks' say. Imports
 * `vitest`: for tests only.
 */
import { Deferred, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, test } from "vitest";
import { definePlugin, Events, Hooks, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { callTools, gated, hang, reply, scriptedLlm, SCRIPTED_MODEL } from "@lemma/llm/testing";
import type { Script } from "@lemma/llm/testing";
import type { LlmRequest } from "@lemma/llm";
import { branchOf, rebuildRequest, Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import { ToolResult, Tools } from "@lemma/tools";
import { Agent, AgentContinueHook, AgentInputHook, TurnEnded, TurnStarted } from "./agent.ts";
import type { PromptContent } from "./agent.ts";

const text = (value: string): PromptContent => [{ type: "text", text: value }];

/** The suite's model, as a provider of `Llm` runs it (through `LlmRequestHook`), recording each request. */
const scriptedModel = (scripts: readonly Script[]) => scriptedLlm(scripts, "conformance-model");

/** The suite's tool, `echo`, recording each run. */
const echoTool = () => {
  const ran: string[] = [];
  const plugin = definePlugin({
    id: "conformance-tools",
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        owner.add(Tools, {
          name: "echo",
          description: "Echoes its text",
          input: Schema.Struct({ text: Schema.String }),
          execute: ({ text: said }: { readonly text: string }) => {
            ran.push(said);
            return new ToolResult({ content: [{ type: "text", text: `echo: ${said}` }] });
          },
        }),
      ),
    ),
  });
  return { plugin, ran };
};

/** Polls `read` until `ready` holds, a few seconds at most. */
const waitFor = <A>(read: Effect.Effect<A>, ready: (value: A) => boolean): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 1_000; tries++) {
      const value = yield* read;
      if (ready(value)) return value;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* Effect.die(new Error("waited too long"));
  });

/**
 * The `Agent` contract as tests. `compose` returns, fresh for each test, the plugins that provide `Agent`, and what
 * it needs but the model and the tools (a `Sessions`, a `ToolRunner`, and the runtime the application would provide):
 * the suite adds a scripted `Llm` (`scriptedLlm`, one model, `scripted/model`) and an `echo` tool. A plugin written to replace
 * `agent.loop` runs it to meet the bar the bundled one does.
 */
export function agentConformance(name: string, compose: () => readonly Plugin[] | Promise<readonly Plugin[]>): void {
  describe(`Agent contract: ${name}`, () => {
    const run = async <A>(
      scripts: readonly Script[],
      body: (context: {
        readonly requests: readonly LlmRequest[];
        readonly ran: readonly string[];
      }) => Effect.Effect<A, unknown, Agent | Sessions | Events | Hooks | Scope.Scope>,
      extra: readonly Plugin[] = [],
    ) => {
      const plugins = await compose();
      const model = scriptedModel(scripts);
      const tools = echoTool();
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([...plugins, model.plugin, tools.plugin, ...extra], {
              configs: { "agent.loop": { defaultModel: SCRIPTED_MODEL.ref } },
            });
            return yield* core.run(body({ requests: model.requests, ran: tools.ran }));
          }),
        ) as Effect.Effect<A, unknown>,
      );
    };
    const log = (sessionId: string) => Effect.flatMap(Sessions, (sessions) => sessions.events(sessionId));
    const types = (events: readonly SessionEvent[]) => events.map((event) => event.data.type);
    const newSession = Effect.flatMap(Sessions, (sessions) => sessions.create());

    test("a prompt is placed, the model asked, its answer logged, and the turn ends done", () =>
      run([reply("hello")], () =>
        Effect.gen(function* () {
          const heard: string[] = [];
          const events = yield* Events;
          yield* Effect.forkScoped(Stream.runForEach(events.stream(TurnStarted), () => Effect.sync(() => heard.push("started"))));
          yield* Effect.forkScoped(Stream.runForEach(events.stream(TurnEnded), (ended) => Effect.sync(() => heard.push(`ended ${ended.reason}`))));
          yield* Effect.yieldNow;
          const { id } = yield* newSession;
          const agent = yield* Agent;
          expect(yield* agent.prompt(id, text("hi"), { requestId: "first" })).toEqual({ kind: "placed" });
          const logged = yield* log(id);
          expect(types(logged)).toEqual(expect.arrayContaining(["turn-start", "message", "turn-end"]));
          const messages = logged.flatMap((event) => (event.data.type === "message" ? [event.data] : []));
          expect(messages[0]).toMatchObject({ requestId: "first", message: { role: "user", content: text("hi") } });
          expect(messages.at(-1)?.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "hello" }] });
          expect(logged.find((event) => event.data.type === "turn-end")?.data).toMatchObject({ reason: "done" });
          expect(yield* agent.busy(id)).toBe(false);
          expect(yield* agent.running).toEqual([]);
          yield* waitFor(
            Effect.sync(() => heard),
            (all) => all.includes("ended done"),
          );
          expect(heard).toEqual(["started", "ended done"]);
        }),
      ));

    test("every request it sends rebuilds from the log", () =>
      run([callTools({ type: "toolCall", id: "c1", name: "echo", arguments: { text: "a" } }), reply("done"), reply("again")], ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const agent = yield* Agent;
          yield* agent.prompt(id, text("go"));
          yield* agent.prompt(id, text("more"));
          const logged = yield* log(id);
          const branch = branchOf(logged, logged.at(-1)!.id);
          const sent = branch.filter((event) => event.data.type === "request");
          expect(sent).toHaveLength(requests.length);
          sent.forEach((event, index) => {
            const rebuilt = rebuildRequest(branch, event.id)!;
            expect(rebuilt.model).toBe(requests[index]!.model);
            expect(rebuilt.system).toBe(requests[index]!.system);
            expect(rebuilt.messages).toEqual(requests[index]!.messages);
            expect((rebuilt.tools ?? []).map((tool) => tool.name)).toEqual((requests[index]!.tools ?? []).map((tool) => tool.name));
          });
        }),
      ));

    test("a prompt sent again with its request id is placed once", () =>
      run([reply("once")], () =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const agent = yield* Agent;
          yield* agent.prompt(id, text("hi"), { requestId: "same" });
          expect(yield* agent.prompt(id, text("hi"), { requestId: "same" })).toEqual({ kind: "placed" });
          const users = (yield* log(id)).filter((event) => event.data.type === "message" && event.data.message.role === "user");
          expect(users).toHaveLength(1);
        }),
      ));

    test("runs each tool the model calls once, and the model reads its result", () =>
      run([callTools({ type: "toolCall", id: "c1", name: "echo", arguments: { text: "ping" } }), reply("done")], ({ requests, ran }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          yield* (yield* Agent).prompt(id, text("go"));
          expect(ran).toEqual(["ping"]);
          const results = (yield* log(id)).flatMap((event) =>
            event.data.type === "message" && event.data.message.role === "toolResult" ? [event.data.message] : [],
          );
          expect(results).toHaveLength(1);
          expect(results[0]).toMatchObject({ toolCallId: "c1", isError: false });
          expect(requests[1]!.messages.some((message) => message.role === "toolResult" && message.toolCallId === "c1")).toBe(true);
        }),
      ));

    test("while a turn runs: reject fails Busy, a follow-up waits for the next turn, a steer joins this one", async () => {
      const gate = Effect.runSync(Deferred.make<void>());
      await run([gated(gate, reply("first")), reply("after steer"), reply("follow-up")], ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const agent = yield* Agent;
          const turn = yield* Effect.forkChild(agent.prompt(id, text("one")));
          yield* waitFor(agent.busy(id), (busy) => busy);
          const refused = yield* Effect.flip(agent.prompt(id, text("no"), { whenBusy: "reject" }));
          expect(refused).toMatchObject({ reason: "Busy" });
          const steer = yield* Effect.forkChild(agent.prompt(id, text("steer"), { whenBusy: "steer" }));
          const follow = yield* Effect.forkChild(agent.prompt(id, text("later"), { whenBusy: "follow-up" }));
          yield* waitFor(Effect.orDie(Effect.map(agent.queue(id), (queue) => queue.length)), (queued) => queued === 2);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(turn);
          yield* Fiber.join(steer);
          yield* Fiber.join(follow);
          const turnStarts = (yield* log(id)).filter((event) => event.data.type === "turn-start");
          expect(turnStarts).toHaveLength(2);
          // The steer reached the first turn's second request; the follow-up started the second turn.
          const said = (request: LlmRequest) =>
            request.messages.flatMap((message) => (message.role === "user" ? message.content.map((part) => (part.type === "text" ? part.text : "")) : []));
          expect(said(requests[1]!)).toContain("steer");
          expect(said(requests[2]!).at(-1)).toBe("later");
        }),
      );
    });

    test("cancel stops a running turn, which ends cancelled", () =>
      run([hang("partial")], ({ requests }) =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const agent = yield* Agent;
          const turn = yield* Effect.forkChild(agent.prompt(id, text("go")));
          // The model asked: the prompt is placed, and the turn runs.
          yield* waitFor(
            Effect.sync(() => requests.length),
            (asked) => asked === 1,
          );
          yield* agent.cancel(id);
          yield* Fiber.join(turn);
          expect(yield* agent.busy(id)).toBe(false);
          expect((yield* log(id)).find((event) => event.data.type === "turn-end")?.data).toMatchObject({ reason: "cancelled" });
        }),
      ));

    test("withdraw takes a queued prompt out before it is placed", async () => {
      const gate = Effect.runSync(Deferred.make<void>());
      await run([gated(gate, reply("first"))], () =>
        Effect.gen(function* () {
          const { id } = yield* newSession;
          const agent = yield* Agent;
          const turn = yield* Effect.forkChild(agent.prompt(id, text("one")));
          yield* waitFor(agent.busy(id), (busy) => busy);
          const queued = yield* Effect.forkChild(Effect.exit(agent.prompt(id, text("never"), { whenBusy: "follow-up", requestId: "out" })));
          yield* waitFor(Effect.orDie(Effect.map(agent.queue(id), (queue) => queue.length)), (count) => count === 1);
          expect(yield* agent.withdraw(id, "out")).toBe(true);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(turn);
          yield* Fiber.join(queued);
          const users = (yield* log(id)).filter((event) => event.data.type === "message" && event.data.message.role === "user");
          expect(users).toHaveLength(1);
        }),
      );
    });

    test("AgentInputHook handles or refuses a prompt, which then reaches neither the model nor the log", async () => {
      const answering = definePlugin({
        id: "answering",
        layer: Layer.effectDiscard(
          Effect.flatMap(PluginContext, (owner) =>
            owner.on(AgentInputHook, (input, next) => {
              const said = input.content[0]?.type === "text" ? input.content[0].text : "";
              return said === "/done"
                ? Effect.succeed({ kind: "handle" as const, message: "did it" })
                : said === "/no"
                  ? Effect.succeed({ kind: "refuse" as const, reason: "not allowed" })
                  : next(input);
            }),
          ),
        ),
      });
      await run(
        [],
        ({ requests }) =>
          Effect.gen(function* () {
            const { id } = yield* newSession;
            const agent = yield* Agent;
            expect(yield* agent.prompt(id, text("/done"))).toMatchObject({ kind: "handled", by: "answering" });
            expect(yield* agent.prompt(id, text("/no"))).toMatchObject({ kind: "refused", by: "answering", reason: "not allowed" });
            expect(requests).toHaveLength(0);
            expect(yield* log(id)).toEqual([]);
          }),
        [answering],
      );
    });

    test("AgentContinueHook stops a turn after a step", async () => {
      const stopping = definePlugin({
        id: "stopping",
        layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(AgentContinueHook, () => Effect.succeed("stop" as const)))),
      });
      await run(
        [callTools({ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }), reply("never asked")],
        ({ requests }) =>
          Effect.gen(function* () {
            const { id } = yield* newSession;
            yield* (yield* Agent).prompt(id, text("go"));
            expect(requests).toHaveLength(1);
            expect((yield* log(id)).find((event) => event.data.type === "turn-end")?.data).toMatchObject({ reason: "done" });
          }),
        [stopping],
      );
    });
  });
}
