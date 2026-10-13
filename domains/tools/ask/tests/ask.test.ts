import { describe, expect, it } from "vitest";
import { Effect, Exit, Fiber, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { Events, Hooks, makeCore, Registries } from "@lemma/core";
import { Channels, elementsOf, resultOf } from "@lemma/contracts";
import type { ChannelCall, ChannelStream } from "@lemma/contracts";
import { AgentInputHook, QueueChanged } from "@lemma/agent";
import type { PromptDecision, QueuedPrompt, WhenBusy } from "@lemma/agent";
import { ToolInvocation, ToolRunner } from "@lemma/tools";
import type { ToolResult } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import ask from "../src/index.ts";
import type { AskDetails, OpenQuestions, QuestionAnswer } from "../src/index.ts";

const QUESTIONS = [
  {
    header: "Storage",
    question: "Where should the cache live?",
    options: [{ label: "SQLite (Recommended)", description: "One file, with transactions" }, { label: "JSON files" }],
  },
  { header: "Auth", question: "How should requests authenticate?", options: [{ label: "Session cookie" }, { label: "API token" }] },
  { header: "Tests", question: "Which tests should cover it?", options: [{ label: "Unit" }, { label: "End to end" }], multiSelect: true },
];

interface Harness {
  /** Calls `ask_user` as the model would, in session `s` unless another is named. */
  readonly call: (input: unknown, toolCallId?: string, sessionId?: string) => Effect.Effect<ToolResult, unknown>;
  /** Opens `ask.open`, as a client that answers does: each list it sends, until the returned scope closes. */
  readonly watch: Effect.Effect<{ readonly until: (pass: (open: readonly OpenQuestions[]) => boolean) => Effect.Effect<void> }, never, Scope.Scope>;
  readonly answer: (toolCallId: string, answers: readonly QuestionAnswer[], sessionId?: string) => Effect.Effect<unknown, unknown>;
  /** Submits a prompt to session `s` through `AgentInputHook`, as the agent does: what it would place. */
  readonly prompt: (whenBusy?: WhenBusy) => Effect.Effect<PromptDecision, unknown>;
  /** Says the session's queue changed, as the agent does. */
  readonly publish: (payload: { readonly sessionId: string; readonly queue: readonly QueuedPrompt[]; readonly revision: number }) => Effect.Effect<void>;
}

const run = <A>(body: (harness: Harness) => Effect.Effect<A, unknown, Scope.Scope | ToolRunner>, waitForClientMs = 0) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([registry, ask], { configs: { "tools.ask": { waitForClientMs } } });
        return yield* core.run(
          Effect.gen(function* () {
            const runner = yield* ToolRunner;
            const events = yield* Events;
            const hooks = yield* Hooks;
            const channels = new Map((yield* (yield* Registries).items(Channels)).map(({ item }) => [item.id, item]));
            const harness: Harness = {
              call: (input, toolCallId = "c1", sessionId = "s") =>
                runner.execute(new ToolInvocation({ sessionId, toolCallId, name: "ask_user", input, cwd: "/" }), new AbortController().signal),
              watch: Effect.gen(function* () {
                const lists = yield* Queue.unbounded<readonly OpenQuestions[]>();
                yield* Effect.forkScoped(
                  Stream.runForEach(elementsOf(channels.get("ask.open") as ChannelStream, undefined), (list) =>
                    Queue.offer(lists, list as readonly OpenQuestions[]),
                  ),
                );
                // The stream has subscribed once its first list arrives: the list as it was.
                const first = yield* Queue.take(lists);
                let last = first;
                return {
                  until: (pass) =>
                    Effect.gen(function* () {
                      while (!pass(last)) last = yield* Queue.take(lists);
                    }),
                };
              }),
              answer: (toolCallId, answers, sessionId = "s") => resultOf(channels.get("ask.answer") as ChannelCall, { sessionId, toolCallId, answers }),
              prompt: (whenBusy) =>
                hooks.invoke(
                  AgentInputHook,
                  { sessionId: "s", content: [{ type: "text", text: "Actually, use Postgres" }], options: whenBusy === undefined ? {} : { whenBusy } },
                  (input) => Effect.succeed({ kind: "place" as const, content: input.content, options: input.options }),
                ),
              publish: (payload) => events.publish(QueueChanged, payload),
            };
            return yield* body(harness);
          }),
        );
      }),
    ),
  );

const detailsOf = (result: ToolResult) => result.details as AskDetails;
/** Lets the forked call and the plugin's observer run as far as they can before the test goes on. */
const settled = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
const has = (toolCallId: string) => (open: readonly OpenQuestions[]) => open.some((entry) => entry.toolCallId === toolCallId);
const none = (open: readonly OpenQuestions[]) => open.length === 0;

describe("ask_user", () => {
  it("waits for a client's answers and tells the model each one, by question", () =>
    run(({ call, watch, answer }) =>
      Effect.gen(function* () {
        const open = yield* watch;
        const asked = yield* Effect.forkChild(call({ questions: QUESTIONS }));
        yield* open.until(has("c1"));
        yield* answer("c1", [
          { kind: "answered", selected: ["SQLite (Recommended)"], text: "keep it under ~/.cache" },
          { kind: "answered", selected: [], text: "Reuse the CLI's token" },
          { kind: "skipped" },
        ]);
        const result = yield* Fiber.join(asked);
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toBe(
          [
            "The user answered:",
            '1. "Where should the cache live?" → chose "SQLite (Recommended)", and added "keep it under ~/.cache"',
            '2. "How should requests authenticate?" → wrote "Reuse the CLI\'s token"',
            '3. "Which tests should cover it?" → skipped: decide yourself',
          ].join("\n"),
        );
        expect(detailsOf(result).outcome.kind).toBe("answered");
        expect(detailsOf(result).questions).toHaveLength(3);
        // Answered, it leaves the list.
        yield* open.until(none);
      }),
    ));

  it("takes the first answer that fits, and refuses one that does not", () =>
    run(({ call, watch, answer }) =>
      Effect.gen(function* () {
        const open = yield* watch;
        const asked = yield* Effect.forkChild(call({ questions: QUESTIONS.slice(0, 1) }));
        yield* open.until(has("c1"));
        const wrong = yield* Effect.exit(answer("c1", [{ kind: "answered", selected: ["Postgres"] }]));
        expect(Exit.isFailure(wrong) && JSON.stringify(wrong.cause)).toContain("InvalidAnswer");
        const two = yield* Effect.exit(answer("c1", [{ kind: "answered", selected: ["SQLite (Recommended)", "JSON files"] }]));
        expect(Exit.isFailure(two) && JSON.stringify(two.cause)).toContain("takes one option");
        yield* answer("c1", [{ kind: "answered", selected: ["JSON files"] }]);
        const late = yield* Effect.exit(answer("c1", [{ kind: "answered", selected: ["SQLite (Recommended)"] }]));
        expect(Exit.isFailure(late) && JSON.stringify(late.cause)).toContain("NotFound");
        expect(textOf(yield* Fiber.join(asked))).toContain('→ chose "JSON files"');
      }),
    ));

  it("answers at once that nobody is available when no client can answer", () =>
    run(({ call }) =>
      Effect.gen(function* () {
        const result = yield* call({ questions: QUESTIONS.slice(0, 1) });
        expect(textOf(result)).toBe("Nobody is available to answer. Go on with your best judgement, and say which assumptions you made.");
        expect(detailsOf(result).outcome).toEqual({ kind: "unavailable" });
      }),
    ));

  it("waits for a client that connects while it waits (a reload, a restart)", () =>
    run(
      ({ call, watch, answer }) =>
        Effect.gen(function* () {
          const asked = yield* Effect.forkChild(call({ questions: QUESTIONS.slice(1, 2) }));
          const open = yield* watch;
          yield* open.until(has("c1"));
          yield* answer("c1", [{ kind: "answered", selected: ["API token"] }]);
          expect(textOf(yield* Fiber.join(asked))).toContain('→ chose "API token"');
        }),
      60_000,
    ));

  it("takes a steer sent meanwhile as the reply, which follows the result", () =>
    run(({ call, watch, publish }) =>
      Effect.gen(function* () {
        const open = yield* watch;
        const asked = yield* Effect.forkChild(call({ questions: QUESTIONS }));
        yield* open.until(has("c1"));
        // A follow-up waits for the turn: the questions stay open.
        yield* publish({
          sessionId: "s",
          queue: [{ requestId: "r1", content: [{ type: "text", text: "later" }], mode: "follow-up", at: 0 }],
          revision: 1,
        });
        yield* publish({
          sessionId: "s",
          queue: [
            { requestId: "r1", content: [{ type: "text", text: "later" }], mode: "follow-up", at: 0 },
            { requestId: "r2", content: [{ type: "text", text: "Actually, use Postgres" }], mode: "steer", at: 1 },
          ],
          revision: 2,
        });
        const result = yield* Fiber.join(asked);
        expect(textOf(result)).toBe("The user did not answer these questions. They sent a message instead, which follows; read it before you go on.");
        expect(detailsOf(result).outcome).toEqual({ kind: "replied" });
        yield* open.until(none);
      }),
    ));

  it("makes a follow-up sent while it waits a steer, so the message reaches the turn it answers", () =>
    run(({ call, watch, prompt }) =>
      Effect.gen(function* () {
        const placed = (decision: PromptDecision) => (decision.kind === "place" ? decision.options.whenBusy : decision.kind);
        expect(placed(yield* prompt())).toBeUndefined();
        const open = yield* watch;
        const asked = yield* Effect.forkChild(call({ questions: QUESTIONS }));
        yield* open.until(has("c1"));
        expect(placed(yield* prompt())).toBe("steer");
        expect(placed(yield* prompt("follow-up"))).toBe("steer");
        expect(placed(yield* prompt("reject"))).toBe("reject");
        yield* Fiber.interrupt(asked);
      }),
    ));

  it("takes a steer queued while it waits for a client as the reply, rather than opening behind it", () =>
    run(
      ({ call, watch, publish }) =>
        Effect.gen(function* () {
          const asked = yield* Effect.forkChild(call({ questions: QUESTIONS }));
          // The call reaches its wait for a client, then the plugin hears the steer on its own fiber, before one connects.
          yield* settled;
          yield* publish({
            sessionId: "s",
            queue: [{ requestId: "r1", content: [{ type: "text", text: "Use Postgres" }], mode: "steer", at: 0 }],
            revision: 1,
          });
          yield* settled;
          yield* watch;
          expect(detailsOf(yield* Fiber.join(asked)).outcome).toEqual({ kind: "replied" });
        }),
      60_000,
    ));

  it("keeps calls of different sessions apart, even under one id (a provider that sends none)", () =>
    run(({ call, watch, answer }) =>
      Effect.gen(function* () {
        const open = yield* watch;
        const first = yield* Effect.forkChild(call({ questions: QUESTIONS.slice(0, 1) }, "", "a"));
        yield* open.until((list) => list.some((entry) => entry.sessionId === "a"));
        const second = yield* Effect.forkChild(call({ questions: QUESTIONS.slice(1, 2) }, "", "b"));
        yield* open.until((list) => list.length === 2);
        yield* answer("", [{ kind: "answered", selected: ["API token"] }], "b");
        expect(textOf(yield* Fiber.join(second))).toContain('→ chose "API token"');
        yield* open.until((list) => list.length === 1 && list[0]!.sessionId === "a");
        yield* answer("", [{ kind: "answered", selected: ["JSON files"] }], "a");
        expect(textOf(yield* Fiber.join(first))).toContain('→ chose "JSON files"');
      }),
    ));

  it("withdraws its questions when the call is cut off, as a cancelled turn cuts it", () =>
    run(({ call, watch }) =>
      Effect.gen(function* () {
        const open = yield* watch;
        const asked = yield* Effect.forkChild(call({ questions: QUESTIONS }));
        yield* open.until(has("c1"));
        yield* Fiber.interrupt(asked);
        yield* open.until(none);
      }),
    ));

  it("refuses questions it could not match answers to, saying why", () =>
    run(({ call }) =>
      Effect.gen(function* () {
        const twice = yield* call({ questions: [{ ...QUESTIONS[1]!, options: [{ label: "Cookie" }, { label: "Cookie" }] }] });
        expect(twice.isError).toBe(true);
        expect(textOf(twice)).toContain('offers "Cookie" twice');
        const one = yield* call({ questions: [{ ...QUESTIONS[1]!, options: [{ label: "Cookie" }] }] });
        expect(one.isError).toBe(true);
      }),
    ));

  it("tells the model its limits in its schema", () =>
    run(() =>
      Effect.gen(function* () {
        const tools = yield* (yield* ToolRunner).list;
        const tool = tools.find((candidate) => candidate.spec.name === "ask_user");
        expect(tool).toMatchObject({ direct: true, replay: "safe" });
        const parameters = JSON.stringify(tool?.spec.parameters);
        expect(parameters).toContain('"minItems":1');
        expect(parameters).toContain('"maxItems":4');
        expect(parameters).toContain('"minItems":2');
      }),
    ));
});
