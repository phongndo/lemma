import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore } from "@lemma/core";
import { Interaction, InteractionError } from "@lemma/contracts";
import { Agent, TurnEnded } from "@lemma/agent";
import type { LlmRequest } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import agentLoop from "@lemma/agent-loop";
import { call, fakeLlm, gated, host, paths, reply, tempDir, useTools } from "../../../agent/loop/tests/fakes.ts";
import type { Script } from "../../../agent/loop/tests/fakes.ts";
import delegate from "../src/index.ts";

// The tool with what it meets in a host: the agent loop and the session store as they run, the model alone faked.

let home: string;
beforeEach(async () => {
  home = await tempDir();
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const nobodyAsks = definePlugin({
  id: "nobody-asks",
  provides: [Interaction],
  layer: Layer.succeed(Interaction, {
    confirm: () => Effect.fail(new InteractionError({ reason: "Unavailable", message: "No client is attached" })),
    ask: () => Effect.die("not asked"),
    select: () => Effect.die("not asked"),
    form: () => Effect.die("not asked"),
  }),
});

/** The text a request's messages hold, the person's and the tools', in order. */
const textsOf = (request: LlmRequest): string[] =>
  request.messages.flatMap((message) => (message.role === "assistant" ? [] : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))));

/**
 * A model that answers by what it is asked: a thread's prompt hands its task on, an agent's task is answered, and a
 * thread that heard back (a tool's result, an agent's notice) says so.
 */
const model =
  (gate: Deferred.Deferred<void>) =>
  (request: LlmRequest): Script => {
    const texts = textsOf(request);
    const last = request.messages.at(-1);
    if (last?.role === "toolResult") return reply("Handed on.");
    if (texts.some((text) => text.includes("<agent_result"))) return reply("Heard back.");
    switch (texts[0]) {
      case "Refactor the reader":
        return useTools(call("c1", "delegate", { prompt: "Map the callers", title: "Map callers" }));
      case "Survey the repo":
        return useTools(call("c2", "delegate", { prompt: "Survey slowly", title: "Survey", background: true }));
      case "Map the callers":
        return reply("Fourteen callers, all in domains/.");
      case "Survey slowly":
        return gated(gate, reply("Three packages."));
      default:
        return reply(`Unexpected: ${texts[0]}`);
    }
  };

const run = <A, E>(body: (gate: Deferred.Deferred<void>, llm: ReturnType<typeof fakeLlm>) => Effect.Effect<A, E, Agent | Sessions | Events>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const llm = fakeLlm(Array.from({ length: 20 }, () => model(gate)));
        const core = yield* makeCore([paths(home, home), host(), nobodyAsks, sessions, tools, llm.plugin, agentLoop, delegate]);
        return yield* core.run(body(gate, llm));
      }),
    ),
  );

const turnStart = (log: readonly SessionEvent[]) => log.find((event) => event.data.type === "turn-start")?.data;

describe("delegate, in the agent loop", () => {
  it("starts an agent, its thread's, whose turn answers the call; the agent logs its depth and runs on the thread's model", async () => {
    const { parent, agents, parentLog, agentLog } = await run(() =>
      Effect.gen(function* () {
        const store = yield* Sessions;
        const agent = yield* Agent;
        const parent = yield* store.create({ cwd: home });
        yield* agent.prompt(parent.id, [{ type: "text", text: "Refactor the reader" }], { requestId: "r1" });
        const agents = (yield* store.list()).filter((info) => info.parent?.sessionId === parent.id);
        return {
          parent,
          agents,
          parentLog: yield* store.branch(parent.id),
          agentLog: agents[0] === undefined ? [] : yield* store.branch(agents[0].id),
        };
      }),
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ parent: { sessionId: parent.id, toolCallId: "c1" }, title: "Map callers" });
    expect(turnStart(agentLog)).toMatchObject({ model: "fake/m1", plugins: { "tools.delegate": { depth: 1 } } });
    const result = parentLog.find((event) => event.data.type === "message" && event.data.message.role === "toolResult")?.data;
    expect(result).toMatchObject({
      details: { sessionId: agents[0]!.id, title: "Map callers", ended: "done", preview: "Fourteen callers, all in domains/." },
    });
    const ended = parentLog.filter((event) => event.data.type === "turn-end").map((event) => event.data);
    expect(ended).toMatchObject([{ reason: "done" }]);
  });

  it("tells the thread when a background agent finishes, which starts its next turn, and forgets the agent once it has", async () => {
    const { requests, agents, parentLog } = await run((gate, llm) =>
      Effect.gen(function* () {
        const store = yield* Sessions;
        const agent = yield* Agent;
        const events = yield* Events;
        const parent = yield* store.create({ cwd: home });
        const ends = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(
              Stream.filter(events.stream(TurnEnded), (ended) => ended.sessionId === parent.id),
              2,
            ),
          ),
        );
        yield* Effect.yieldNow;
        yield* agent.prompt(parent.id, [{ type: "text", text: "Survey the repo" }], { requestId: "r1" });
        // The thread's turn ended with the agent at work; the agent finishes now.
        expect((yield* store.list()).filter((info) => info.parent?.sessionId === parent.id)).toHaveLength(1);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(ends);
        const dir = path.join(home, "delegate", "agents");
        for (let i = 0; i < 1000 && (yield* Effect.promise(() => fs.readdir(dir).catch(() => []))).length > 0; i++) yield* Effect.yieldNow;
        expect(yield* Effect.promise(() => fs.readdir(dir).catch(() => []))).toEqual([]);
        return {
          requests: llm.requests,
          agents: (yield* store.list()).filter((info) => info.parent?.sessionId === parent.id),
          parentLog: yield* store.branch(parent.id),
        };
      }),
    );
    expect(agents[0]).toMatchObject({ title: "Survey" });
    const notice = parentLog.find((event) => event.data.type === "context")?.data;
    expect(notice).toMatchObject({ source: "tools.delegate", requestId: "tools.delegate:c2", display: "Survey finished" });
    // The thread's next turn read the agent's answer.
    const heard = [...requests].reverse().find((request) => textsOf(request).some((text) => text.includes("<agent_result")));
    expect(textsOf(heard!).join("\n")).toContain("Three packages.");
    expect(parentLog.filter((event) => event.data.type === "turn-end").map((event) => event.data)).toMatchObject([{ reason: "done" }, { reason: "done" }]);
  });
});
