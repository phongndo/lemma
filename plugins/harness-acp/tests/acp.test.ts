import * as fs from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { Effect, Fiber, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Agent, Harnesses, Interaction, InteractionError, Sessions } from "@lemma/contracts";
import type { EventData, InteractionRequest, SessionEvent } from "@lemma/contracts";
import { fakeLlm, host, paths, reply, tempDir, testTools, waitFor } from "../../agent/tests/fakes.ts";
import agent from "../../agent/src/index.ts";
import harnesses from "../../harnesses/src/index.ts";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import { acpPlugin, TURN_KIND } from "../src/index.ts";
import type { AgentSpec, StartAgent, Transport } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Prompt = (params: acp.PromptRequest, client: acp.AgentContext, signal: AbortSignal) => Promise<acp.PromptResponse>;

/** An ACP agent in this process: each `session/prompt` plays the next script. Records what it was asked. */
const fakeAgent = (scripts: Prompt[], capabilities: acp.AgentCapabilities = {}) => {
  const log = {
    starts: 0,
    created: [] as acp.NewSessionRequest[],
    resumed: [] as string[],
    prompts: [] as acp.PromptRequest[],
    cancelled: [] as string[],
  };
  let die: ((reason: string) => void) | undefined;
  const start: StartAgent = () => {
    log.starts++;
    let next = 0;
    const running = new Map<string, AbortController>();
    const app = acp
      .agent({ name: "fake" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: capabilities,
        agentInfo: { name: "fake", version: "9.9" },
      }))
      .onRequest(acp.methods.agent.session.new, (ctx) => {
        log.created.push(ctx.params);
        return { sessionId: `s${log.starts}-${++next}` };
      })
      .onRequest(acp.methods.agent.session.resume, (ctx) => {
        log.resumed.push(ctx.params.sessionId);
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        log.prompts.push(ctx.params);
        const controller = new AbortController();
        running.set(ctx.params.sessionId, controller);
        const script = scripts.shift();
        return script === undefined ? { stopReason: "end_turn" } : script(ctx.params, ctx.client, controller.signal);
      })
      .onNotification(acp.methods.agent.session.cancel, (ctx) => {
        log.cancelled.push(ctx.params.sessionId);
        running.get(ctx.params.sessionId)?.abort();
      });
    const exited = new Promise<string>((resolve) => {
      die = resolve;
    });
    const transport: Transport = { target: { app }, stderr: () => "panic: out of tokens", exited, close: async () => die?.("was closed") };
    return transport;
  };
  return { start, log, kill: (reason: string) => die?.(reason) };
};

/** Answers every `select` with the option `pick` chooses, and records the questions. */
const answering = (pick: (request: Extract<InteractionRequest, { type: "select" }>) => string | undefined) => {
  const asked: Extract<InteractionRequest, { type: "select" }>[] = [];
  const plugin = definePlugin({
    id: "interaction",
    provides: [Interaction],
    layer: Layer.succeed(Interaction, {
      confirm: () => Effect.succeed(true),
      ask: () => Effect.succeed(""),
      select: (title, options, detail) =>
        Effect.suspend(() => {
          const request = { type: "select" as const, id: "q", title, options, ...(detail === undefined ? {} : { detail }) };
          asked.push(request);
          const value = pick(request);
          return value === undefined ? Effect.fail(new InteractionError({ reason: "Dismissed", message: "no" })) : Effect.succeed(value as never);
        }),
    }),
  });
  return { plugin, asked };
};

const spec: AgentSpec = { id: "fake", title: "Fake", command: "fake-acp", args: [] };

const run = <A, E>(
  setup: {
    readonly agent: ReturnType<typeof fakeAgent>;
    readonly interaction?: Plugin;
    readonly scripts?: Parameters<typeof fakeLlm>[0];
    readonly agents?: readonly AgentSpec[];
  },
  body: Effect.Effect<A, E, Agent | Sessions | Harnesses>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = acpPlugin({ start: setup.agent.start, status: () => Effect.succeed({ state: "ready" }) });
        const core = yield* makeCore(
          [
            paths(dir, dir),
            host(),
            sessions,
            harnesses,
            tools,
            testTools().plugin,
            fakeLlm(setup.scripts ?? []).plugin,
            agent,
            setup.interaction ?? answering(() => undefined).plugin,
            plugin,
          ],
          { configs: { acp: { agents: setup.agents ?? [spec] } } },
        );
        return yield* core.run(body);
      }),
    ),
  );

const text = (value: string) => [{ type: "text" as const, text: value }];
const ofType = <T extends EventData["type"]>(events: readonly SessionEvent[], type: T) =>
  events.flatMap((event) => (event.data.type === type ? [event.data as Extract<EventData, { type: T }>] : []));
const newSession = Effect.flatMap(Sessions, (store) => store.create({ cwd: dir }));
const log = (sessionId: string) => Effect.flatMap(Sessions, (store) => store.events(sessionId));
const prompt = (sessionId: string, value: string, harness?: string) =>
  Effect.flatMap(Agent, (a) => a.prompt(sessionId, text(value), harness === undefined ? {} : { harness }));

const update = (client: acp.AgentContext, sessionId: string, value: acp.SessionUpdate) =>
  client.notify(acp.methods.client.session.update, { sessionId, update: value });

/** Says it will edit, asks to, edits (with a diff), and reports what it cost. */
const editTurn: Prompt = async (params, client) => {
  const { sessionId } = params;
  await update(client, sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Plan the edit." } });
  await update(client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Editing " } });
  await update(client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a.ts." } });
  await update(client, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "Edit a.ts",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/w/a.ts" }],
    rawInput: { path: "/w/a.ts" },
  });
  const answer = await client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: "c1", title: "Edit a.ts", rawInput: { path: "/w/a.ts" } },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Skip", kind: "reject_once" },
    ],
  });
  if (answer.outcome.outcome !== "selected" || answer.outcome.optionId !== "yes") {
    await update(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Refused" } }],
    });
    return { stopReason: "end_turn" };
  }
  await update(client, sessionId, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } });
  await update(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    content: [{ type: "diff", path: "/w/a.ts", oldText: "a = 1\n", newText: "a = 2\n" }],
  });
  await update(client, sessionId, { sessionUpdate: "usage_update", used: 20, size: 100, cost: { amount: 0.75, currency: "USD" } });
  await update(client, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  return { stopReason: "end_turn", usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340, cachedReadTokens: 100 } };
};

const said =
  (value: string): Prompt =>
  async (params, client) => {
    await update(client, params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
    return { stopReason: "end_turn" };
  };

const promptText = (request: acp.PromptRequest) => request.prompt.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("");

describe("acp harness", () => {
  it("runs a turn on the agent: its text, thinking, calls, diffs, permission questions and cost, logged as Lemma logs a turn", async () => {
    const fake = fakeAgent([editTurn]);
    const questions = answering((request) => request.options.find((option) => option.label === "Allow")?.value);
    await run(
      { agent: fake, interaction: questions.plugin },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Make a two", "fake");
        const events = yield* log(id);
        expect(ofType(events, "turn-start")[0]).toMatchObject({ harness: "fake" });
        const marker = ofType(events, "custom").find((event) => event.kind === TURN_KIND);
        expect(marker?.data).toMatchObject({ agent: "fake", session: "s1-1" });
        const messages = ofType(events, "message");
        expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
        expect(messages[1]!.message).toMatchObject({
          role: "assistant",
          api: "acp",
          provider: "fake",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "Plan the edit." },
            { type: "text", text: "Editing a.ts." },
            { type: "toolCall", id: "c1", name: "edit", arguments: { title: "Edit a.ts", path: "/w/a.ts" } },
          ],
        });
        expect(messages[2]).toMatchObject({ message: { toolCallId: "c1", isError: false, content: text("Edited /w/a.ts") }, details: { kind: "edit" } });
        expect((messages[2]!.details as { diff: string }).diff).toContain("-a = 1\n+a = 2");
        expect(messages[3]!.message).toMatchObject({ content: text("Done."), stopReason: "stop" });
        // The first cost update set the baseline; the turn's cost is what the total grew by.
        const usage = messages.flatMap((entry) => (entry.message.role === "assistant" ? [entry.message.usage] : []));
        expect(usage.reduce((sum, u) => sum + u.cost.total, 0)).toBeCloseTo(0.25);
        expect(usage.reduce((sum, u) => sum + u.input, 0)).toBe(300);
        expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "done" });
        expect(questions.asked).toHaveLength(1);
        expect(questions.asked[0]).toMatchObject({
          title: "Fake wants to Edit a.ts",
          options: [{ label: "Allow", description: "Allow this time" }, { label: "Skip" }],
        });
        expect(questions.asked[0]!.detail).toContain("/w/a.ts");
        expect(fake.log.created).toEqual([{ cwd: dir, mcpServers: [] }]);
      }),
    );
  });

  it("refuses for the user when nobody answers, and the agent goes on", async () => {
    const fake = fakeAgent([editTurn]);
    await run(
      { agent: fake },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Make a two", "fake");
        const messages = ofType(yield* log(id), "message");
        expect(messages[2]!.message).toMatchObject({ toolCallId: "c1", isError: true, content: text("Refused") });
      }),
    );
  });

  it("continues the agent's session on the next turn, without telling it the conversation again", async () => {
    const fake = fakeAgent([said("One."), said("Two.")]);
    await run(
      { agent: fake },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "First", "fake");
        yield* prompt(id, "Second");
        expect(fake.log.created).toHaveLength(1);
        expect(fake.log.prompts.map((request) => [request.sessionId, promptText(request)])).toEqual([
          ["s1-1", "First"],
          ["s1-1", "Second"],
        ]);
      }),
    );
  });

  it("hands the conversation over as text when a session moves to the agent", async () => {
    const fake = fakeAgent([said("Hello from fake.")]);
    await run(
      { agent: fake, scripts: [reply("Hi from Lemma.")] },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Hello");
        yield* prompt(id, "Over to you", "fake");
        const sent = promptText(fake.log.prompts[0]!);
        expect(sent).toContain("This conversation began before you joined it");
        expect(sent).toContain("<user>\nHello\n</user>");
        expect(sent).toContain("<assistant>\nHi from Lemma.\n</assistant>");
        expect(sent.endsWith("Over to you")).toBe(true);
        const marker = ofType(yield* log(id), "custom").find((event) => event.kind === TURN_KIND);
        expect(marker?.data).toMatchObject({ handoffChars: expect.any(Number) });
        expect((marker!.data as { handoffChars: number }).handoffChars).toBeGreaterThan(0);
      }),
    );
  });

  it("starts a new session with the conversation after a checkout back past the agent's last turn", async () => {
    const fake = fakeAgent([said("One."), said("Two."), said("Three.")]);
    await run(
      { agent: fake },
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* newSession;
        yield* prompt(id, "First", "fake");
        const afterFirst = (yield* store.get(id)).leaf!;
        yield* prompt(id, "Second");
        yield* store.checkout(id, afterFirst);
        yield* prompt(id, "Instead");
        expect(fake.log.created).toHaveLength(2);
        const last = fake.log.prompts[2]!;
        expect(last.sessionId).toBe("s1-2");
        expect(promptText(last)).toContain("<assistant>\nOne.\n</assistant>");
        expect(promptText(last)).not.toContain("Two.");
      }),
    );
  });

  it("resumes the agent's session after its process restarts", async () => {
    const fake = fakeAgent([said("One."), said("Two.")], { sessionCapabilities: { resume: {} } });
    await run(
      { agent: fake },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "First", "fake");
        fake.kill("crashed");
        yield* prompt(id, "Second");
        expect(fake.log.starts).toBe(2);
        expect(fake.log.resumed).toEqual(["s1-1"]);
        expect(fake.log.prompts.map((request) => [request.sessionId, promptText(request)])).toEqual([
          ["s1-1", "First"],
          ["s1-1", "Second"],
        ]);
      }),
    );
  });

  it("cancels the agent's prompt when the turn is cancelled", async () => {
    const fake = fakeAgent([
      async (params, client, signal) => {
        await update(client, params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Run tests",
          kind: "execute",
          rawInput: { command: "make test" },
        });
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { stopReason: "cancelled" };
      },
    ]);
    await run(
      { agent: fake },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const running = yield* Effect.fork(prompt(id, "Test it", "fake"));
        yield* waitFor(
          Effect.map(log(id), (events) => ofType(events, "step-start").length),
          (n) => n === 1,
        );
        yield* Effect.flatMap(Agent, (a) => a.cancel(id));
        yield* Fiber.join(running);
        expect(fake.log.cancelled).toEqual(["s1-1"]);
        const events = yield* log(id);
        expect(ofType(events, "message").map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
        expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "cancelled" });
      }),
    );
  });

  it("ends the turn with what the agent printed when its process dies mid-turn", async () => {
    let fake: ReturnType<typeof fakeAgent>;
    fake = fakeAgent([
      async (params, client) => {
        await update(client, params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } });
        fake.kill("exited with code 1");
        return new Promise<acp.PromptResponse>(() => {});
      },
    ]);
    await run(
      { agent: fake },
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Go", "fake");
        const end = ofType(yield* log(id), "turn-end")[0]!;
        expect(end.reason).toBe("error");
        expect(end.error).toContain("Fake exited with code 1");
        expect(end.error).toContain("panic: out of tokens");
      }),
    );
  });

  it("lists an agent that is not installed as unavailable, saying how to install it", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore(
            [paths(dir, dir), host(), sessions, harnesses, answering(() => undefined).plugin, acpPlugin({ start: fakeAgent([]).start })],
            { configs: { acp: { agents: [{ id: "ghost", command: "no-such-agent-lemma-test", install: "Install ghost." }] } } },
          );
          return yield* core.run(Effect.flatMap(Harnesses, (registry) => registry.list));
        }),
      ),
    );
    expect(result).toMatchObject([
      { id: "ghost", source: "acp", status: { state: "unavailable", detail: "no-such-agent-lemma-test was not found on PATH. Install ghost." } },
    ]);
  });
});
