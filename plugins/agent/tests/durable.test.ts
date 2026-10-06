import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, PluginContext } from "@lemma/core";
import { Agent, emptyUsage, SessionAppended, Sessions, ToolResult } from "@lemma/contracts";
import type { EventData, SessionEvent, Tool } from "@lemma/contracts";
import { LiveTurn } from "../src/live.ts";
import { INTERRUPTED_CALL, planResume } from "../src/resume.ts";
import { call, failWith, gated, hang, log, newSession, ofType, reply, runAgent, tempDir, text, types, useTools, waitFor } from "./fakes.ts";
import type { AgentSetup } from "./fakes.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** One run of the agent over `dir` (see `runAgent`). Without a grace to finish what runs (`stopGrace: 0` unless the config says otherwise), closing cuts the turn off where it is, as a crash would. */
const run = <A, E>(setup: AgentSetup, body: Parameters<typeof runAgent<A, E>>[2]) =>
  runAgent(dir, { ...setup, config: { stopGrace: 0, ...setup.config } }, body);

const userTexts = (events: readonly SessionEvent[]) =>
  ofType(events, "message").flatMap((data) =>
    data.message.role === "user" ? data.message.content.map((part) => (part.type === "text" ? part.text : "")) : [],
  );

const ended = (sessionId: string, count = 1) => waitFor(log(sessionId), (events) => ofType(events, "turn-end").length >= count);
const stateFiles = () => fs.readdir(path.join(dir, "agent")).catch(() => [] as string[]);

/** Prints a line, then runs until its call is aborted: a long command cut off by a restart. */
const slow: Tool<Record<string, never>> = {
  name: "slow",
  description: "Takes a while.",
  input: Schema.Struct({}),
  execute: (_, { update, signal }) =>
    new Promise((resolve) => {
      update?.("step 1 done\n");
      signal.addEventListener("abort", () => resolve(new ToolResult({ content: [{ type: "text", text: "aborted" }] })), { once: true });
    }),
};

describe("queue", () => {
  it("runs a prompt sent while a turn runs as the next turn; each caller waits for its own", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await run({ scripts: [gated(gate, reply("first")), reply("second")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        const before = (yield* a.view(id)).queueRevision;
        const second = yield* Effect.forkChild(a.prompt(id, text("two")));
        const [queued] = yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        // Every change to the queue moves its revision on, so a client keeps the newest of what it hears.
        expect((yield* a.view(id)).queueRevision).toBeGreaterThan(before);
        expect(queued).toMatchObject({ mode: "follow-up", content: text("two") });
        expect((yield* a.view(id)).queue).toHaveLength(1);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        const events = yield* log(id);
        expect(ofType(events, "turn-end").map((end) => end.reason)).toEqual(["done", "done"]);
        expect(userTexts(events)).toEqual(["one", "two"]);
        expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        expect(rec.started).toHaveLength(2);
        expect(yield* a.queue(id)).toEqual([]);
      }),
    );
  });

  it("places a steer between steps, so the model answers it in the same turn even after it had stopped", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await run({ scripts: [gated(gate, reply("first answer")), reply("answer to the steer")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        const steer = yield* Effect.forkChild(a.prompt(id, text("also this"), { whenBusy: "steer", requestId: "s1" }));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(steer);
        const events = yield* log(id);
        expect(types(events)).toEqual([
          "turn-start",
          "message",
          "title",
          "step-start",
          "request",
          "message",
          "step-end",
          "message",
          "step-start",
          "request",
          "message",
          "step-end",
          "turn-end",
        ]);
        const steered = ofType(events, "message")[2]!;
        expect(steered).toMatchObject({ requestId: "s1", message: { role: "user" } });
        expect(steered.turnId).toBe(ofType(events, "turn-start")[0]!.turnId);
        expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: text("also this") });
        expect(rec.started).toHaveLength(1);
      }),
    );
  });

  it("places a prompt once per request id: a retry waits for the same turn, or returns once it has ended", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    // One script: a second turn would fail with "no script left".
    await run({ scripts: [gated(gate, reply("hi"))] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("hello"), { requestId: "r1" }));
        yield* waitFor(a.busy(id), (busy) => busy);
        const retry = yield* Effect.forkChild(a.prompt(id, text("hello"), { requestId: "r1" }));
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(retry);
        yield* a.prompt(id, text("hello"), { requestId: "r1" });
        const events = yield* log(id);
        expect(ofType(events, "turn-start")).toHaveLength(1);
        expect(ofType(events, "message")[0]).toMatchObject({ requestId: "r1" });
      }),
    );
  });

  it("withdraws a queued prompt: its caller fails Withdrawn and no turn runs it", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await run({ scripts: [gated(gate, reply("a"))] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        const second = yield* Effect.forkChild(a.prompt(id, text("two"), { requestId: "w" }));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        expect(yield* a.withdraw(id, "w")).toBe(true);
        expect((yield* Effect.flip(Fiber.join(second))).reason).toBe("Withdrawn");
        expect(yield* a.withdraw(id, "w")).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        expect(ofType(yield* log(id), "turn-start")).toHaveLength(1);
      }),
    );
  });

  it("holds the queue after a failed turn until the next prompt, which places it first", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await run({ scripts: [gated(gate, failWith("boom")), reply("both")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        const second = yield* Effect.forkChild(a.prompt(id, text("two")));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* waitFor(a.busy(id), (busy) => !busy);
        expect(yield* a.queue(id)).toHaveLength(1);
        yield* a.prompt(id, text("three"));
        yield* Fiber.join(second);
        const events = yield* log(id);
        expect(ofType(events, "turn-end").map((end) => end.reason)).toEqual(["error", "done"]);
        expect(userTexts(events)).toEqual(["one", "two", "three"]);
      }),
    );
  });
});

describe("queue races", () => {
  it("a cancel that comes while a steer is placed does not leave it queued to be placed again", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    // Cancels the turn the moment the steer's message is in the log, between its logging and its leaving the queue.
    const canceller = definePlugin({
      id: "canceller",
      requires: [Agent],
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const agent = yield* Agent;
          yield* owner.observe(SessionAppended, ({ sessionId, event }) =>
            event.data.type === "message" && event.data.requestId === "s1" ? agent.cancel(sessionId) : Effect.void,
          );
        }),
      ),
    });
    // Whether the cancelled step's call reaches the model depends on where the cancel lands: any reply serves either way.
    await run({ scripts: [gated(gate, reply("first")), reply("second"), reply("third")], plugins: [canceller] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        yield* Effect.forkChild(a.prompt(id, text("also this"), { whenBusy: "steer", requestId: "s1" }));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* waitFor(a.busy(id), (busy) => !busy);
        expect(yield* a.queue(id)).toEqual([]);
        yield* a.prompt(id, text("three"));
        expect(userTexts(yield* log(id))).toEqual(["one", "also this", "three"]);
      }),
    );
  });

  it("a retry of a prompt held in the queue after a failed turn starts it", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    await run({ scripts: [gated(gate, failWith("boom")), reply("held one")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        const first = yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        yield* Effect.forkChild(a.prompt(id, text("two"), { requestId: "r1" }));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* waitFor(a.busy(id), (busy) => !busy);
        // The client lost its connection and sends it again.
        yield* a.prompt(id, text("two"), { requestId: "r1" });
        const events = yield* log(id);
        expect(ofType(events, "turn-end").map((end) => end.reason)).toEqual(["error", "done"]);
        expect(userTexts(events)).toEqual(["one", "two"]);
      }),
    );
  });
});

describe("view", () => {
  it("shows the model output so far, numbered so later deltas can be told apart", async () => {
    await run({ scripts: [hang("partial text")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("go")));
        const view = yield* waitFor(a.view(id), (current) => (current.draft?.blocks.length ?? 0) > 0);
        expect(view.turnId).toBeDefined();
        expect(view.draft).toMatchObject({ seq: 2, blocks: [{ index: 0, block: { type: "text", text: "partial text" } }] });
        yield* a.cancel(id);
        const idle = yield* a.view(id);
        expect(idle).toMatchObject({ output: [], queue: [] });
        expect(idle.turnId).toBeUndefined();
      }),
    );
  });
});

describe("resume", () => {
  it("resumes a turn cut off mid-call: the partial answer is logged as interrupted and the call is asked again", async () => {
    const id = await run({ scripts: [hang("half an ans")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(a.view(id), (view) => (view.draft?.blocks.length ?? 0) > 0);
        return id;
      }),
    );
    expect(await stateFiles()).toEqual(expect.arrayContaining([`${id}.json`, `${id}.live.json`]));
    await run({ scripts: [reply("done now")] }, ({ requests, rec }) =>
      Effect.gen(function* () {
        const events = yield* ended(id);
        expect(types(events)).toEqual([
          "turn-start",
          "message",
          "title",
          "step-start",
          "request",
          "custom",
          "attempt",
          "step-end",
          "step-start",
          "request",
          "message",
          "step-end",
          "turn-end",
        ]);
        expect(ofType(events, "attempt")[0]!.message).toMatchObject({ content: [{ type: "text", text: "half an ans" }], errorMessage: INTERRUPTED_CALL });
        expect(ofType(events, "turn-end")[0]!.reason).toBe("done");
        expect(requests).toHaveLength(1);
        expect(rec.started).toEqual([ofType(events, "turn-start")[0]!.turnId]);
        yield* waitFor(
          Effect.promise(() => stateFiles()),
          (files) => files.length === 0,
        );
      }),
    );
  });

  it("resumes cut-off tool calls: one safe to repeat runs again, another tells the model it was interrupted, with its output", async () => {
    let peeks = 0;
    const peek: Tool<Record<string, never>> = {
      name: "peek",
      description: "Looks.",
      input: Schema.Struct({}),
      replay: "safe",
      execute: async () => {
        peeks++;
        return new ToolResult({ content: [{ type: "text", text: "peeked" }] });
      },
    };
    const id = await run({ scripts: [useTools(call("t1", "slow", {}), call("t2", "peek", {}))], tools: [slow, peek] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(a.view(id), (view) => view.output.some((entry) => entry.output.includes("step 1 done")));
        return id;
      }),
    );
    expect(peeks).toBe(0);
    await run({ scripts: [reply("recovered")], tools: [slow, peek] }, ({ requests }) =>
      Effect.gen(function* () {
        const events = yield* ended(id);
        const results = ofType(events, "message").flatMap((data) => (data.message.role === "toolResult" ? [data.message] : []));
        expect(results.map((result) => [result.toolCallId, result.isError])).toEqual([
          ["t1", true],
          ["t2", false],
        ]);
        const interrupted = results[0]!.content[0]!;
        expect(interrupted.type === "text" && interrupted.text).toMatch(/interrupted[\s\S]*step 1 done/);
        expect(peeks).toBe(1);
        expect(requests[0]!.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
        expect(ofType(events, "turn-end")[0]!.reason).toBe("done");
      }),
    );
  });

  it("resumes on the turn's own events when renames during its call made a longer branch, so a finished tool is not run again", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const id = await run({ scripts: [gated(gate, useTools(call("t1", "echo", { text: "once" }), call("t2", "slow", {})))], tools: [slow] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(log(id), (events) => types(events).includes("request"));
        const store = yield* Sessions;
        for (const title of ["one", "two", "three"]) yield* store.append(id, { type: "title", title });
        yield* Deferred.succeed(gate, undefined);
        yield* waitFor(a.view(id), (view) => view.output.some((entry) => entry.output.includes("step 1 done")));
        return id;
      }),
    );
    await run({ scripts: [reply("done")], tools: [slow] }, ({ requests, executed }) =>
      Effect.gen(function* () {
        yield* ended(id);
        expect(executed).toEqual([]);
        const results = requests[0]!.messages.filter((message) => message.role === "toolResult");
        expect(results.map((result) => (result.role === "toolResult" ? [result.toolCallId, result.isError] : []))).toEqual([
          ["t1", false],
          ["t2", true],
        ]);
      }),
    );
  });

  it("does not ask the model again when the cut-off call was the last the turn had steps for", async () => {
    const id = await run({ scripts: [hang("half")], config: { maxSteps: 1 } }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(a.view(id), (view) => (view.draft?.blocks.length ?? 0) > 0);
        return id;
      }),
    );
    await run({ scripts: [reply("over budget")], config: { maxSteps: 1 } }, ({ requests }) =>
      Effect.gen(function* () {
        const events = yield* ended(id);
        expect(requests).toHaveLength(0);
        expect(ofType(events, "request")).toHaveLength(1);
        expect(ofType(events, "turn-end")[0]!.reason).toBe("max-steps");
      }),
    );
  });

  it("closes a resumed turn as cancelled when the cancel came before the restart", async () => {
    const id = await run({ scripts: [hang("never finished")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("go")));
        yield* waitFor(a.view(id), (view) => (view.draft?.blocks.length ?? 0) > 0);
        return id;
      }),
    );
    // As if the host stopped while closing the turn: the journal says a cancel was asked for.
    const file = path.join(dir, "agent", `${id}.json`);
    const journal = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...journal, turn: { ...journal.turn, cancelling: true } }));
    await run({ scripts: [] }, ({ requests }) =>
      Effect.gen(function* () {
        const events = yield* ended(id);
        expect(types(events).slice(-4)).toEqual(["custom", "attempt", "step-end", "turn-end"]);
        expect(ofType(events, "attempt")[0]!.message).toMatchObject({ stopReason: "aborted", content: [{ type: "text", text: "never finished" }] });
        expect(ofType(events, "turn-end")[0]!.reason).toBe("cancelled");
        expect(requests).toHaveLength(0);
      }),
    );
  });

  it("does not run a turn cut off before its first event that was cancelled meanwhile", async () => {
    const id = await run({ scripts: [] }, () => Effect.map(newSession, (info) => info.id));
    // As if the host stopped right after recording the turn, before logging it, and a cancel came before it resumed.
    await fs.mkdir(path.join(dir, "agent"), { recursive: true });
    const prompt = { requestId: "r", content: text("go"), mode: "follow-up", at: 1 };
    await fs.writeFile(path.join(dir, "agent", `${id}.json`), JSON.stringify({ turn: { turnId: "t-cut", prompts: [prompt], cancelling: true }, queue: [] }));
    await run({ scripts: [reply("should not run")] }, ({ requests }) =>
      Effect.gen(function* () {
        yield* waitFor(
          Effect.promise(() => stateFiles()),
          (files) => files.length === 0,
        );
        expect(yield* log(id)).toEqual([]);
        expect(requests).toHaveLength(0);
      }),
    );
  });

  it("keeps the queue across a restart and runs it after the resumed turn", async () => {
    const id = await run({ scripts: [hang("one")] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const a = yield* Agent;
        yield* Effect.forkChild(a.prompt(id, text("one")));
        yield* waitFor(a.busy(id), (busy) => busy);
        yield* Effect.forkChild(a.prompt(id, text("two"), { requestId: "next" }));
        yield* waitFor(a.queue(id), (queue) => queue.length === 1);
        return id;
      }),
    );
    await run({ scripts: [reply("one done"), reply("two done")] }, () =>
      Effect.gen(function* () {
        const events = yield* ended(id, 2);
        expect(ofType(events, "turn-end").map((end) => end.reason)).toEqual(["done", "done"]);
        expect(userTexts(events)).toEqual(["one", "two"]);
        expect(ofType(events, "message").find((data) => data.requestId === "next")).toBeDefined();
        // A retry of the queued prompt after the restart finds it placed.
        yield* Effect.flatMap(Agent, (a) => a.prompt(id, text("two"), { requestId: "next" }));
        expect(ofType(yield* log(id), "turn-start")).toHaveLength(2);
      }),
    );
  });
});

describe("planResume", () => {
  const event = (seq: number, id: string, parent: string | null, data: EventData): SessionEvent => ({ seq, id, parent, at: seq, data });

  it("follows the turn's own path past a title hung off it, and finds the step a cut-off call was in", () => {
    const events = [
      event(1, "a", null, { type: "turn-start", turnId: "t", model: "fake/m1" }),
      event(2, "b", "a", { type: "message", turnId: "t", requestId: "r", message: { role: "user", content: text("go"), timestamp: 1 } }),
      event(3, "x", "b", { type: "title", title: "renamed" }),
      event(4, "c", "b", { type: "step-start", turnId: "t", stepId: "s" }),
      event(5, "d", "c", { type: "request", turnId: "t", stepId: "s", model: "fake/m1", composition: "c", contributions: [] }),
    ];
    const resume = planResume(events, "t");
    expect(resume).toMatchObject({ kind: "open", plan: { lastId: "d", model: "fake/m1", steps: 1, at: { kind: "model", stepId: "s", logged: false } } });
    expect(resume.kind === "open" && [...resume.plan.placed]).toEqual(["r"]);
  });

  it("answers a steer placed after the last step before the restart, rather than closing the turn", () => {
    const answer = {
      role: "assistant" as const,
      content: [],
      api: "a",
      provider: "p",
      model: "m",
      usage: emptyUsage,
      stopReason: "stop" as const,
      timestamp: 1,
    };
    const events = [
      event(1, "a", null, { type: "turn-start", turnId: "t" }),
      event(2, "b", "a", { type: "message", turnId: "t", message: { role: "user", content: text("go"), timestamp: 1 } }),
      event(3, "c", "b", { type: "step-start", turnId: "t", stepId: "s" }),
      event(4, "d", "c", { type: "message", turnId: "t", stepId: "s", message: answer }),
      event(5, "e", "d", { type: "step-end", turnId: "t", stepId: "s" }),
      event(6, "f", "e", { type: "message", turnId: "t", requestId: "s1", message: { role: "user", content: text("also"), timestamp: 1 } }),
    ];
    expect(planResume(events, "t")).toMatchObject({ kind: "open", plan: { steps: 1, at: { kind: "between", steered: true } } });
  });

  it("closes a turn whose failed call's step was closed before the restart, and retries one closed on an interrupted call", () => {
    const failed = (errorMessage: string) => ({
      role: "assistant" as const,
      content: [],
      api: "a",
      provider: "p",
      model: "m",
      usage: emptyUsage,
      stopReason: "error" as const,
      errorMessage,
      timestamp: 1,
    });
    const closedOn = (errorMessage: string) => [
      event(1, "a", null, { type: "turn-start", turnId: "t" }),
      event(2, "b", "a", { type: "step-start", turnId: "t", stepId: "s" }),
      event(3, "c", "b", { type: "attempt", turnId: "t", stepId: "s", message: failed(errorMessage), timing: { startedAt: 1, endedAt: 2 } }),
      event(4, "d", "c", { type: "step-end", turnId: "t", stepId: "s" }),
    ];
    expect(planResume(closedOn("rate limited"), "t")).toMatchObject({ kind: "open", plan: { at: { kind: "failed", stepId: "s", closed: true } } });
    expect(planResume(closedOn(INTERRUPTED_CALL), "t")).toMatchObject({ kind: "open", plan: { at: { kind: "between", steered: false } } });
  });

  it("remembers an overflow asked again before other failures, so a restart does not ask one again", () => {
    const failed = {
      role: "assistant" as const,
      content: [],
      api: "a",
      provider: "p",
      model: "m",
      usage: emptyUsage,
      stopReason: "error" as const,
      timestamp: 1,
    };
    const timing = { startedAt: 1, endedAt: 2 };
    const events = [
      event(1, "a", null, { type: "turn-start", turnId: "t" }),
      event(2, "b", "a", { type: "step-start", turnId: "t", stepId: "s1" }),
      event(3, "c", "b", {
        type: "attempt",
        turnId: "t",
        stepId: "s1",
        message: failed,
        timing,
        failure: { kind: "overflow" },
        retry: { reason: "failure", attempt: 1, at: 2 },
      }),
      event(4, "d", "c", { type: "step-end", turnId: "t", stepId: "s1" }),
      event(5, "e", "d", { type: "step-start", turnId: "t", stepId: "s2" }),
      event(6, "f", "e", {
        type: "attempt",
        turnId: "t",
        stepId: "s2",
        message: failed,
        timing,
        failure: { kind: "transient" },
        retry: { reason: "failure", attempt: 2, at: 9 },
      }),
      event(7, "g", "f", { type: "step-end", turnId: "t", stepId: "s2" }),
    ];
    expect(planResume(events, "t")).toMatchObject({
      kind: "open",
      plan: { steps: 0, retry: { attempts: 2, overflow: false, overflowed: true, at: 9 }, at: { kind: "between" } },
    });
  });

  it("follows the turn's own events past renames chained off it while its call was pending", () => {
    const answer = {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "c1", name: "echo", arguments: { text: "x" } }],
      api: "a",
      provider: "p",
      model: "m",
      usage: emptyUsage,
      stopReason: "toolUse" as const,
      timestamp: 1,
    };
    const events = [
      event(1, "a", null, { type: "turn-start", turnId: "t" }),
      event(2, "b", "a", { type: "message", turnId: "t", message: { role: "user", content: text("go"), timestamp: 1 } }),
      event(3, "c", "b", { type: "step-start", turnId: "t", stepId: "s" }),
      event(4, "d", "c", { type: "request", turnId: "t", stepId: "s", model: "fake/m1", composition: "c", contributions: [] }),
      // Three renames while the call ran, each at the session's leaf: a chain longer than what the turn logged next.
      event(5, "x1", "d", { type: "title", title: "one" }),
      event(6, "x2", "x1", { type: "title", title: "two" }),
      event(7, "x3", "x2", { type: "title", title: "three" }),
      event(8, "e", "d", { type: "message", turnId: "t", stepId: "s", message: answer }),
      event(9, "f", "e", {
        type: "message",
        turnId: "t",
        stepId: "s",
        message: { role: "toolResult", toolCallId: "c1", toolName: "echo", content: text("echo: x"), isError: false, timestamp: 1 },
      }),
    ];
    expect(planResume(events, "t")).toMatchObject({ kind: "open", plan: { lastId: "f", at: { kind: "tools", stepId: "s", pending: [] } } });
  });

  it("says when the turn never started or already ended", () => {
    expect(planResume([], "t")).toEqual({ kind: "not-started" });
    const events = [event(1, "a", null, { type: "turn-start", turnId: "t" }), event(2, "b", "a", { type: "turn-end", turnId: "t", reason: "done" })];
    expect(planResume(events, "t")).toEqual({ kind: "ended", reason: "done" });
  });
});

describe("LiveTurn", () => {
  it("drops output that arrives for a tool after its result, and keeps each block's stream index", () => {
    const live = new LiveTurn("t");
    live.toolOutput("c1", "partial", 0);
    live.toolEnded("c1");
    live.toolOutput("c1", " late", 7);
    expect(live.view().output).toEqual([]);
    live.startStep("s", 1);
    live.apply({ type: "text-delta", index: 1, delta: "after a gap" });
    expect(live.view().draft?.blocks).toEqual([{ index: 1, block: { type: "text", text: "after a gap" } }]);
  });
});
