import * as fs from "node:fs/promises";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext, Registries } from "@lemma/core";
import { Agent, AgentError, Harnesses, listHarnesses, NATIVE_HARNESS, transcript } from "@lemma/agent";
import type { Harness, HarnessStatus, HarnessTurn, HarnessUpdate } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import { closeHarnessTurn, HARNESS_STATE, movedOn, previousOf } from "../src/harness.ts";
import { unansweredCalls } from "../src/turn.ts";
import { log, newSession, ofType, paths, reply, runAgent, tempDir, text, types, waitFor } from "./fakes.ts";
import type { AgentSetup } from "./fakes.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Play = (turn: HarnessTurn) => Stream.Stream<HarnessUpdate, { readonly message: string }>;

/** A harness `other` that plays one script per turn, in order, and records the turns it was handed. */
function fakeHarness(plays: readonly Play[], status: HarnessStatus = { state: "ready" }) {
  const turns: HarnessTurn[] = [];
  const queue = [...plays];
  const harness: Harness = {
    id: "other",
    title: "Other agent",
    status: Effect.succeed(status),
    run: (turn) => {
      turns.push(turn);
      const next = queue.shift();
      return next === undefined ? Stream.fail({ message: "no script left" }) : next(turn);
    },
  };
  const plugin = definePlugin({
    id: "fake-harness",
    layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(Harnesses, harness))),
  });
  return { plugin, turns };
}

const updates =
  (...items: HarnessUpdate[]): Play =>
  () =>
    Stream.fromIterable(items);

const withAgent = <A, E>(setup: AgentSetup, body: Parameters<typeof runAgent<A, E>>[2]) => runAgent(dir, setup, body);

const onOther = { harness: "other" };

describe("a turn on another harness", () => {
  it("logs a call's result when it comes, though the agent wrote on meanwhile", async () => {
    const other = fakeHarness([
      updates(
        { type: "tool-call", id: "a", name: "read", arguments: {} },
        { type: "tool-call", id: "b", name: "run", arguments: {} },
        { type: "tool-result", id: "a", content: [{ type: "text", text: "read it" }], isError: false },
        { type: "text", delta: "While b runs…" },
        { type: "tool-result", id: "b", content: [{ type: "text", text: "ran it" }], isError: false },
        { type: "text", delta: " done." },
      ),
    ]);
    await withAgent({ scripts: [], models: [], plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* (yield* Agent).prompt(id, text("go"), onOther);
        const events = yield* log(id);
        const results = ofType(events, "message").filter((data) => data.message.role === "toolResult");
        expect(results.map((data) => [data.message.role === "toolResult" && data.message.toolCallId, JSON.stringify(data.message.content)])).toEqual([
          ["a", JSON.stringify([{ type: "text", text: "read it" }])],
          ["b", JSON.stringify([{ type: "text", text: "ran it" }])],
        ]);
        // Each under the step that called it.
        const callingStep = ofType(events, "message").find((data) => data.message.role === "assistant")!.stepId;
        expect(results.map((data) => data.stepId)).toEqual([callingStep, callingStep]);
        expect(unansweredCalls(events)).toBeUndefined();
      }),
    );
  });

  it("is logged as the agent logs its own: each message the other agent writes a step, its tool results after it", async () => {
    const other = fakeHarness([
      updates(
        { type: "model", model: "claude-x" },
        { type: "thinking", delta: "Let me " },
        { type: "thinking", delta: "look." },
        { type: "text", delta: "Reading " },
        { type: "text", delta: "it." },
        { type: "tool-call", id: "c1", name: "read", arguments: {} },
        { type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } },
        { type: "tool-output", id: "c1", chunk: "line 1" },
        { type: "tool-result", id: "c1", content: [{ type: "text", text: "line 1" }], isError: false, details: { lines: 1 } },
        { type: "text", delta: "Done." },
        { type: "usage", usage: { ...emptyUsage, input: 3, output: 4, totalTokens: 7 } },
      ),
    ]);
    // No model at all: a harness turn needs none.
    await withAgent({ scripts: [], models: [], plugins: [other.plugin] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        expect(yield* agent.prompt(id, text("read a.ts"), onOther)).toEqual({ kind: "placed" });
        const events = yield* log(id);
        expect(types(events)).toEqual([
          "turn-start",
          "message",
          "title",
          "step-start",
          "message",
          "message",
          "step-end",
          "step-start",
          "message",
          "step-end",
          "turn-end",
        ]);
        expect(ofType(events, "turn-start")[0]).toMatchObject({ harness: "other" });
        const messages = ofType(events, "message").map((data) => data.message);
        expect(messages[1]).toMatchObject({
          role: "assistant",
          provider: "other",
          model: "claude-x",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "Let me look." },
            { type: "text", text: "Reading it." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
          ],
        });
        expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "read", isError: false });
        expect(ofType(events, "message")[2]?.details).toEqual({ lines: 1 });
        expect(messages[3]).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] });
        // What the whole turn cost, as the harness reports it, is logged with its end.
        expect(ofType(events, "turn-end")).toEqual([
          { type: "turn-end", turnId: ofType(events, "turn-start")[0]!.turnId, reason: "done", usage: { ...emptyUsage, input: 3, output: 4, totalTokens: 7 } },
        ]);
        expect(rec.ended.map((ended) => [ended.reason, ended.usage.totalTokens])).toEqual([["done", 7]]);
        expect(rec.deltas.filter((event) => event.type === "text-delta").map((event) => event.type === "text-delta" && event.delta)).toEqual([
          "Reading ",
          "it.",
          "Done.",
        ]);
        expect(unansweredCalls(events)).toBeUndefined();
      }),
    );
    expect(other.turns.map((turn) => turn.prompts)).toEqual([[text("read a.ts")]]);
  });

  it("fails NoHarness, logging nothing, when the harness is not added or cannot run turns", async () => {
    const other = fakeHarness([], { state: "unavailable", detail: "Install it first." });
    await withAgent({ scripts: [], plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        const missing = yield* Effect.flip(agent.prompt(id, text("hi"), { harness: "nowhere" }));
        expect(missing).toBeInstanceOf(AgentError);
        expect(missing.reason).toBe("NoHarness");
        const unavailable = yield* Effect.flip(agent.prompt(id, text("hi"), onOther));
        expect([unavailable.reason, unavailable.message]).toEqual(["NoHarness", "Other agent cannot run turns now: Install it first."]);
        expect(ofType(yield* log(id), "turn-start")).toEqual([]);
      }),
    );
  });

  it("hands the harness back what it kept, with what was said since; the native loop after it is given the conversation as text", async () => {
    const other = fakeHarness([
      updates({ type: "state", data: { session: "s-1" } }, { type: "text", delta: "First answer." }),
      updates({ type: "text", delta: "Third answer." }),
    ]);
    await withAgent({ scripts: [reply("Second answer.")], plugins: [other.plugin] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        yield* agent.prompt(id, text("one"), onOther);
        yield* agent.prompt(id, text("two"));
        yield* agent.prompt(id, text("three"), onOther);
        const events = yield* log(id);
        // The native turn: a compaction keeping its prompt, summarizing the other agent's turn.
        const [compaction] = ofType(events, "compaction");
        expect(compaction?.summary).toContain("<assistant>\nFirst answer.\n</assistant>");
        const nativeRequest = requests[0]!;
        expect(nativeRequest.messages.map((message) => message.role)).toEqual(["user", "user"]);
        expect(ofType(events, "custom").filter((data) => data.kind === HARNESS_STATE)).toEqual([
          { type: "custom", kind: HARNESS_STATE, data: { harness: "other", state: { session: "s-1" } } },
        ]);
      }),
    );
    expect(other.turns[0]?.previous).toBeUndefined();
    expect(other.turns[0]?.history).toEqual([]);
    expect(other.turns[1]?.previous?.state).toEqual({ session: "s-1" });
    expect(other.turns[1]?.previous?.since.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(transcript(other.turns[1]!.previous!.since)).toBe("<user>\ntwo\n</user>\n\n<assistant>\nSecond answer.\n</assistant>");
  });

  it("hands back nothing kept on a branch the harness has since gone on from on another", async () => {
    const other = fakeHarness([
      updates({ type: "state", data: { session: "s-1" } }, { type: "text", delta: "A." }),
      updates({ type: "state", data: { session: "s-1" } }, { type: "text", delta: "B." }),
      updates({ type: "text", delta: "C." }),
    ]);
    await withAgent({ scripts: [], models: [], plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        const store = yield* Sessions;
        yield* agent.prompt(id, text("a"), onOther);
        const afterA = (yield* log(id)).at(-1)!.id;
        yield* agent.prompt(id, text("b"), onOther);
        // Back to after A: the other agent's session holds B, which this branch does not.
        yield* store.checkout(id, afterA);
        yield* agent.prompt(id, text("c"), onOther);
      }),
    );
    expect(other.turns[1]?.previous?.state).toEqual({ session: "s-1" });
    expect(other.turns[2]?.previous).toBeUndefined();
    expect(transcript(other.turns[2]!.history)).toBe("<user>\na\n</user>\n\n<assistant>\nA.\n</assistant>");
  });

  it("closes as cancelled when cancelled: what the other agent wrote logged as it stood, its open call answered", async () => {
    const other = fakeHarness([
      () =>
        Stream.concat(
          Stream.fromIterable<HarnessUpdate>([
            { type: "text", delta: "Working" },
            { type: "tool-call", id: "c1", name: "bash", arguments: { command: "sleep 100" } },
          ]),
          Stream.never,
        ),
    ]);
    await withAgent({ scripts: [], plugins: [other.plugin] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        const running = yield* Effect.forkChild(agent.prompt(id, text("go"), onOther));
        yield* waitFor(
          Effect.sync(() => rec.deltas.length),
          (count) => count >= 3,
        );
        yield* agent.cancel(id);
        yield* Fiber.join(running);
        const events = yield* log(id);
        expect(ofType(events, "turn-end").map((end) => end.reason)).toEqual(["cancelled"]);
        const [, assistant, result] = ofType(events, "message").map((data) => data.message);
        expect(assistant).toMatchObject({
          role: "assistant",
          stopReason: "aborted",
          content: [
            { type: "text", text: "Working" },
            { type: "toolCall", id: "c1" },
          ],
        });
        expect(result).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: true });
        expect(unansweredCalls(events)).toBeUndefined();
      }),
    );
  });

  it("ends in error with the harness's message when its stream fails", async () => {
    const other = fakeHarness([
      () => Stream.concat(Stream.fromIterable<HarnessUpdate>([{ type: "text", delta: "Hm" }]), Stream.fail({ message: "not signed in" })),
    ]);
    await withAgent({ scripts: [], plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        const failed = yield* Effect.flip(agent.prompt(id, text("go"), onOther));
        expect(failed.message).toBe("Other agent: not signed in");
        const events = yield* log(id);
        expect(ofType(events, "turn-end")).toMatchObject([{ reason: "error", error: "Other agent: not signed in" }]);
      }),
    );
  });

  it("is closed, not left open, when the host stops during it, and the next start finds it ended", async () => {
    const other = fakeHarness([() => Stream.concat(Stream.fromIterable<HarnessUpdate>([{ type: "text", delta: "Started" }]), Stream.never)]);
    const id = await withAgent({ scripts: [], plugins: [other.plugin], config: { stopGrace: 0 } }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const agent = yield* Agent;
        yield* Effect.forkChild(agent.prompt(id, text("go"), onOther));
        yield* waitFor(
          Effect.sync(() => rec.deltas.length),
          (count) => count >= 2,
        );
        return id;
      }),
    );
    await withAgent({ scripts: [reply("native")], plugins: [fakeHarness([]).plugin] }, () =>
      Effect.gen(function* () {
        const events = yield* log(id);
        // Its plugin stops before the agent does, which ends the turn.
        expect(ofType(events, "turn-end")).toMatchObject([
          { reason: "error", error: "Other agent stopped while it ran the turn: its plugin stopped, or the host did." },
        ]);
        expect(unansweredCalls(events)).toBeUndefined();
        // The session takes prompts again.
        const agent = yield* Agent;
        expect(yield* agent.prompt(id, text("again"))).toEqual({ kind: "placed" });
      }),
    );
  });

  it("lists every harness with its status, the agent's own loop first", async () => {
    const other = fakeHarness([], { state: "unavailable", detail: "Not on PATH" });
    await withAgent({ scripts: [], models: [], plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const listed = yield* listHarnesses(yield* Registries);
        expect(listed).toEqual([
          {
            id: NATIVE_HARNESS,
            title: "Lemma",
            description: "Lemma's own agent, on the model you pick",
            source: "agent.loop",
            logo: expect.objectContaining({ viewBox: "-16 -16 664 664" }),
            status: { state: "unavailable", detail: "No model is available: connect a provider." },
          },
          { id: "other", title: "Other agent", source: "fake-harness", status: { state: "unavailable", detail: "Not on PATH" } },
        ]);
      }),
    );
  });
});

describe("closeHarnessTurn", () => {
  it("answers the open calls of a turn a crash cut off, ends its step, and ends it in error", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(dir, dir), sessions]);
          yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const { id } = yield* store.create();
              yield* store.append(id, { type: "turn-start", turnId: "t1", harness: "other" });
              yield* store.append(id, { type: "message", message: { role: "user", content: text("go"), timestamp: 1 }, turnId: "t1", requestId: "r1" });
              yield* store.append(id, { type: "step-start", turnId: "t1", stepId: "s1" });
              yield* store.append(id, {
                type: "message",
                message: {
                  role: "assistant",
                  content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
                  api: "harness",
                  provider: "other",
                  model: "other",
                  usage: emptyUsage,
                  stopReason: "toolUse",
                  timestamp: 2,
                },
                turnId: "t1",
                stepId: "s1",
              });
              const events = yield* Events;
              expect(yield* closeHarnessTurn({ sessions: store, events }, { sessionId: id, turnId: "t1", harness: "other", cancelling: false })).toBe("error");
              const logged = yield* store.events(id);
              expect(types(logged).slice(-3)).toEqual(["message", "step-end", "turn-end"]);
              expect(unansweredCalls(logged)).toBeUndefined();
            }),
          );
        }),
      ),
    ));
});

describe("previousOf", () => {
  it("is undefined until the harness has run a turn that kept state", () => {
    expect(previousOf([], "other")).toBeUndefined();
  });
});

describe("movedOn", () => {
  const event = (seq: number, harness: string): SessionEvent => ({
    seq,
    id: `e${seq}`,
    parent: null,
    at: seq,
    data: { type: "custom", kind: HARNESS_STATE, data: { harness, state: { session: `s${seq}` } } },
  });
  it("says a branch's state is stale once the harness kept a later one on another branch", () => {
    const branch = [event(1, "other")];
    expect(movedOn([event(1, "other")], branch, "other")).toBe(false);
    // Another harness's later state leaves this one's as it was.
    expect(movedOn([event(1, "other"), event(2, "else")], branch, "other")).toBe(false);
    expect(movedOn([event(1, "other"), event(2, "other")], branch, "other")).toBe(true);
    expect(movedOn([event(2, "other")], [], "other")).toBe(false);
  });
});
