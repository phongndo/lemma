import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Agent, AgentError, Harnesses, NATIVE_HARNESS, Sessions } from "@lemma/contracts";
import type { EventData, HarnessStatus, HarnessTurn, LlmRequest, SessionEvent } from "@lemma/contracts";
import { recordTurn } from "../../harnesses/src/index.ts";
import type { Ended, TurnRecorder } from "../../harnesses/src/index.ts";
import harnesses from "../../harnesses/src/index.ts";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";
import { fakeLlm, host, paths, recorder, reply, tempDir, testTools, usage, waitFor } from "./fakes.ts";
import type { Script } from "./fakes.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Body = (recorder: TurnRecorder, turn: HarnessTurn) => Effect.Effect<Ended, AgentError>;

/** Another agent, as a harness plugin would wrap it: each turn plays the next body through the recorder. */
const otherAgent = (id: string, bodies: Body[], status: HarnessStatus = { state: "ready" }) => {
  const turns: HarnessTurn[] = [];
  const plugin = definePlugin({
    id: `harness-${id}`,
    requires: [Harnesses, Sessions],
    layer: Layer.scopedDiscard(
      Effect.gen(function* () {
        const registry = yield* Harnesses;
        const services = { sessions: yield* Sessions, events: yield* Events };
        yield* registry.register({
          id,
          title: `Agent ${id}`,
          capabilities: { steer: false, models: false, resume: false, requests: false },
          status: Effect.succeed(status),
          run: (turn) =>
            recordTurn(services, turn, { harness: id, api: "test", provider: id, model: "theirs", title: `Agent ${id}` }, (rec) => {
              turns.push(turn);
              const body = bodies.shift();
              return body === undefined ? Effect.succeed({ reason: "done" }) : body(rec, turn);
            }),
        });
      }),
    ),
  });
  return { plugin, turns };
};

const run = <A, E>(
  setup: { readonly scripts?: readonly Script[]; readonly plugins: readonly Plugin[]; readonly config?: Record<string, unknown> },
  body: (fixture: { readonly requests: LlmRequest[]; readonly rec: ReturnType<typeof recorder> }) => Effect.Effect<A, E, Agent | Sessions | Harnesses>,
) => {
  const llm = fakeLlm(setup.scripts ?? []);
  const rec = recorder();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore(
          [paths(dir, dir), host(), sessions, harnesses, tools, testTools().plugin, llm.plugin, agent, rec.plugin, ...setup.plugins],
          {
            configs: { agent: setup.config ?? {} },
          },
        );
        return yield* core.run(body({ requests: llm.requests, rec }));
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
const prompt = (sessionId: string, value: string, harness?: string) =>
  Effect.flatMap(Agent, (a) => a.prompt(sessionId, text(value), harness === undefined ? {} : { harness }));

/** Reads a file, edits it, and says so: two steps, the way an agent that ran tools reports them. */
const readAndEdit: Body = (rec) =>
  Effect.gen(function* () {
    yield* rec.thinking("Look first.");
    yield* rec.text("Reading it.");
    yield* rec.toolCall({ id: "t1", name: "read", arguments: {} });
    // The input arrives after the call: the call on record has it.
    yield* rec.toolCall({ id: "t1", name: "read", arguments: { path: "a.ts" } });
    yield* rec.toolResult("t1", { content: text("export const a = 1;"), isError: false });
    yield* rec.toolCall({ id: "t2", name: "edit", arguments: { path: "a.ts" } });
    yield* rec.toolResult("t2", { content: text("Edited"), isError: false, details: { diff: "-1\n+2" } });
    // A result for a call it never reported is not the record's.
    yield* rec.toolResult("t9", { content: text("stray"), isError: false });
    yield* rec.text("Done: a is 2.");
    yield* rec.usage(usage(100, 20));
    return { reason: "done" } satisfies Ended;
  });

describe("harnesses", () => {
  it("lists the native harness first, ready, with every capability", async () => {
    const other = otherAgent("other", []);
    await run({ plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const listed = yield* Effect.flatMap(Harnesses, (registry) => registry.list);
        expect(listed.map((harness) => [harness.id, harness.source, harness.status.state])).toEqual([
          [NATIVE_HARNESS, "agent", "ready"],
          ["other", "harness-other", "ready"],
        ]);
        expect(listed[0]!.capabilities).toEqual({ steer: true, models: true, resume: true, requests: true });
      }),
    );
  });

  it("runs a turn on the harness the prompt names, logged as the native loop logs one", async () => {
    const other = otherAgent("other", [readAndEdit]);
    await run({ plugins: [other.plugin] }, ({ rec, requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Make a two", "other");
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
          "message",
          "step-end",
          "step-start",
          "message",
          "step-end",
          "turn-end",
        ]);
        expect(ofType(events, "turn-start")[0]).toMatchObject({ harness: "other" });
        const messages = ofType(events, "message");
        expect(messages[1]!.message).toMatchObject({
          role: "assistant",
          provider: "other",
          model: "theirs",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "Look first." },
            { type: "text", text: "Reading it." },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
          ],
        });
        expect(messages[2]!.message).toMatchObject({ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false });
        expect(messages[2]!.stepId).toBe(messages[1]!.stepId);
        expect(messages[4]).toMatchObject({ message: { role: "toolResult", toolCallId: "t2" }, details: { diff: "-1\n+2" } });
        expect(messages[5]!.message).toMatchObject({
          role: "assistant",
          stopReason: "stop",
          content: text("Done: a is 2."),
          usage: { input: 100, output: 20 },
        });
        expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "done" });
        // Nothing went to Lemma's model, and nothing claims a request it cannot rebuild.
        expect(requests).toEqual([]);
        expect(ofType(events, "request")).toEqual([]);
        yield* waitFor(
          Effect.sync(() => rec.ended.length),
          (n) => n === 1,
        );
        expect(rec.ended[0]).toMatchObject({ reason: "done", usage: { input: 100, output: 20 } });
        expect(rec.deltas.map((event) => event.type)).toEqual([
          "thinking-delta",
          "text-delta",
          "toolcall-start",
          "toolcall-end",
          "toolcall-end",
          "toolcall-start",
          "toolcall-end",
          "text-delta",
        ]);
      }),
    );
  });

  it("keeps a session on its harness until a prompt names another, and hands the conversation over as text", async () => {
    const other = otherAgent("other", [readAndEdit, (rec) => Effect.as(rec.text("Still me."), { reason: "done" } as const)]);
    await run({ plugins: [other.plugin], scripts: [reply("Back on Lemma.")] }, ({ requests }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Make a two", "other");
        yield* prompt(id, "And then?");
        expect(other.turns.map((turn) => turn.prompts[0]!.content)).toEqual([text("Make a two"), text("And then?")]);
        yield* prompt(id, "Your turn", NATIVE_HARNESS);
        const events = yield* log(id);
        const harnessesOf = ofType(events, "turn-start").map((start) => start.harness);
        expect(harnessesOf).toEqual(["other", "other", undefined]);
        const [handoff] = ofType(events, "compaction");
        expect(handoff).toMatchObject({ source: "agent" });
        expect(handoff!.summary).toContain("Earlier turns ran on another agent");
        expect(handoff!.summary).toContain("<user>\nMake a two\n</user>");
        expect(handoff!.summary).toContain('[called edit {"path":"a.ts"}]');
        expect(handoff!.summary).toContain("Still me.");
        // The model sees the handoff and the new prompt, never the other agent's tool calls as its own.
        expect(requests).toHaveLength(1);
        const [summary, asked] = requests[0]!.messages;
        expect(summary).toMatchObject({ role: "user" });
        expect(JSON.stringify(summary)).toContain("Still me.");
        expect(asked).toMatchObject({ role: "user", content: text("Your turn") });
        expect(requests[0]!.messages).toHaveLength(2);
      }),
    );
  });

  it("starts a session on the configured default harness", async () => {
    const other = otherAgent("other", []);
    await run({ plugins: [other.plugin], config: { defaultHarness: "other" } }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* prompt(id, "Hi");
        expect(ofType(yield* log(id), "turn-start")[0]).toMatchObject({ harness: "other" });
      }),
    );
  });

  it("refuses a harness that is not registered or not ready, before anything is logged", async () => {
    const missing = otherAgent("missing", [], { state: "unavailable", detail: "Install it first." });
    await run({ plugins: [missing.plugin] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const unknown = yield* Effect.flip(prompt(id, "Hi", "nope"));
        expect(unknown).toMatchObject({ _tag: "AgentError", reason: "NoHarness" });
        expect(unknown.message).toContain('No harness "nope"');
        const unready = yield* Effect.flip(prompt(id, "Hi", "missing"));
        expect(unready).toMatchObject({ reason: "NoHarness", message: "Agent missing cannot run turns now: Install it first." });
        expect(yield* log(id)).toEqual([]);
      }),
    );
  });

  it("cancels a turn another agent is running, answering the call it left open", async () => {
    const other = otherAgent("other", [
      (rec) =>
        Effect.gen(function* () {
          yield* rec.toolCall({ id: "t1", name: "bash", arguments: { command: "sleep 100" } });
          yield* rec.toolResult("t0", { content: [], isError: false });
          return yield* Effect.never;
        }),
    ]);
    await run({ plugins: [other.plugin] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        const running = yield* Effect.fork(prompt(id, "Wait", "other"));
        yield* waitFor(
          Effect.sync(() => rec.deltas.length),
          (n) => n >= 2,
        );
        yield* Effect.flatMap(Agent, (a) => a.cancel(id));
        yield* Fiber.join(running);
        const events = yield* log(id);
        const messages = ofType(events, "message");
        expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
        expect(messages[1]!.message).toMatchObject({ stopReason: "aborted", errorMessage: "Cancelled" });
        expect(messages[2]!.message).toMatchObject({ toolCallId: "t1", isError: true, content: text("Tool execution was cancelled.") });
        expect(types(events).slice(-2)).toEqual(["step-end", "turn-end"]);
        expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "cancelled" });
      }),
    );
  });

  it("ends a turn whose body fails as an error, with the failure", async () => {
    const other = otherAgent("other", [
      (rec) => Effect.zipRight(rec.text("Partial"), Effect.fail(new AgentError({ sessionId: "s", reason: "Session", message: "agent crashed" }))),
    ]);
    await run({ plugins: [other.plugin] }, () =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.either(prompt(id, "Go", "other"));
        const events = yield* log(id);
        expect(ofType(events, "message")[1]!.message).toMatchObject({ stopReason: "error", errorMessage: "agent crashed", content: text("Partial") });
        expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "error", error: "agent crashed" });
      }),
    );
  });

  it("closes another agent's turn when the host stops during it, keeping what it produced", async () => {
    const other = otherAgent("other", [
      (rec) =>
        Effect.gen(function* () {
          yield* rec.text("Running it.");
          yield* rec.toolCall({ id: "t1", name: "bash", arguments: { command: "sleep 100" } });
          return yield* Effect.never;
        }),
    ]);
    const id = await run({ plugins: [other.plugin] }, ({ rec }) =>
      Effect.gen(function* () {
        const { id } = yield* newSession;
        yield* Effect.fork(prompt(id, "Run it", "other"));
        yield* waitFor(
          Effect.sync(() => rec.deltas.length),
          (n) => n >= 3,
        );
        return id;
      }),
    );
    // Started again, the agent finds the turn closed and leaves it be.
    await run({ plugins: [otherAgent("other", []).plugin] }, () =>
      Effect.gen(function* () {
        const events = yield* log(id);
        expect(types(events).slice(-4)).toEqual(["message", "message", "step-end", "turn-end"]);
        const [, call, answer] = ofType(events, "message");
        expect(call!.message).toMatchObject({
          stopReason: "error",
          content: [
            { type: "text", text: "Running it." },
            { type: "toolCall", id: "t1" },
          ],
        });
        expect(answer!.message).toMatchObject({ role: "toolResult", toolCallId: "t1", isError: true });
        expect(ofType(events, "turn-end")).toHaveLength(1);
        expect(ofType(events, "turn-end")[0]!.error).toContain("Lemma stopped while Agent other was running this turn");
      }),
    );
  });

  /** What a crash leaves of a turn on the other agent: its call logged, no result, no `turn-end`, and the journal naming it. */
  const crashed = () =>
    run({ plugins: [] }, () =>
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* newSession;
        const start = yield* store.append(id, { type: "turn-start", turnId: "t-cut", harness: "other" });
        const step = yield* store.append(id, { type: "step-start", turnId: "t-cut", stepId: "s1" }, { parent: start.id });
        yield* store.append(
          id,
          {
            type: "message",
            turnId: "t-cut",
            stepId: "s1",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
              api: "test",
              provider: "other",
              model: "theirs",
              usage: usage(1, 1),
              stopReason: "toolUse",
              timestamp: 1,
            },
          },
          { parent: step.id },
        );
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, "agent"), { recursive: true });
          const prompts = [{ requestId: "r", content: text("Run it"), mode: "follow-up", at: 1 }];
          await fs.writeFile(path.join(dir, "agent", `${id}.json`), JSON.stringify({ turn: { turnId: "t-cut", prompts }, queue: [] }));
        });
        return id;
      }),
    );

  for (const [name, plugins] of [
    ["is still registered", () => [otherAgent("other", []).plugin]],
    ["is gone", () => []],
  ] as const) {
    it(`closes another agent's turn a crash left open when that harness ${name}, answering its open call`, async () => {
      const id = await crashed();
      await run({ plugins: plugins() }, () =>
        Effect.gen(function* () {
          const events = yield* waitFor(log(id), (logged) => ofType(logged, "turn-end").length === 1);
          expect(types(events).slice(-3)).toEqual(["message", "step-end", "turn-end"]);
          expect(ofType(events, "message").at(-1)!.message).toMatchObject({ role: "toolResult", toolCallId: "t1", isError: true });
          expect(ofType(events, "turn-end")[0]).toMatchObject({ reason: "error" });
          expect(ofType(events, "turn-end")[0]!.error).toContain("cannot continue it");
        }),
      );
    });
  }
});
