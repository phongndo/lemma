import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { awaitable, definePlugin, makeCore, Registries } from "@lemma/core";
import { PromptSections } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { ToolInvocation, ToolRunner } from "@lemma/tools";
import { textOf } from "@lemma/tools/testing";
import registry from "@lemma/tools-registry";
import todo, { apply, reminder, todosOf } from "../todo.ts";
import type { Todo } from "../todo.ts";

/** A logged `todo` result carrying `todos`, as the agent appends one. */
const result = (todos: readonly Todo[], isError = false): EventData => ({
  type: "message",
  message: { role: "toolResult", toolCallId: "c", toolName: "todo", content: [{ type: "text", text: "" }], isError, timestamp: 0 },
  details: { todos },
});
const event = (data: EventData, index: number): SessionEvent => ({
  seq: index,
  id: `e${index}`,
  parent: index === 0 ? null : `e${index - 1}`,
  at: index,
  data,
});

describe("the list", () => {
  it("is the last successful todo call's on the branch", () => {
    const first = [{ id: 1, text: "a", done: false }];
    const second = [...first, { id: 2, text: "b", done: false }];
    expect(todosOf([result(first), result(second), result([], true)].map(event))).toEqual(second);
    expect(todosOf([])).toEqual([]);
  });

  it("adds, marks done, and lists; a call it cannot apply throws, for the model to read", () => {
    const added = apply(apply([], { action: "add", text: "write tests" }).todos, { action: "add", text: "ship" });
    expect(added.todos).toEqual([
      { id: 1, text: "write tests", done: false },
      { id: 2, text: "ship", done: false },
    ]);
    const done = apply(added.todos, { action: "done", id: 1 });
    expect(apply(done.todos, { action: "list" }).text).toBe("#1 [x] write tests\n#2 [ ] ship");
    expect(() => apply(done.todos, { action: "done", id: 9 })).toThrow("No todo #9");
    expect(reminder(done.todos)).toBe("Open items on your todo list (the `todo` tool):\n- #2 ship");
    expect(reminder(apply(done.todos, { action: "done", id: 2 }).todos)).toBeUndefined();
  });
});

describe("as a plugin", () => {
  it("adds its tool and a prompt section, both reading the session's log", async () => {
    // The session's log, which the test grows as the agent would, with each result.
    const log: SessionEvent[] = [];
    const sessions = definePlugin({
      id: "sessions",
      provides: [Sessions],
      layer: Layer.succeed(Sessions, { branch: () => Effect.sync(() => [...log]) } as unknown as Context.Service.Shape<typeof Sessions>),
    });
    const [texts, section] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([sessions, registry, todo]);
          return yield* core.run(
            Effect.gen(function* () {
              const runner = yield* ToolRunner;
              const call = (input: unknown) =>
                Effect.tap(
                  runner.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c", name: "todo", input, cwd: "/" }), new AbortController().signal),
                  (done) => Effect.sync(() => void log.push(event({ ...result([]), details: done.details } as EventData, log.length))),
                );
              const texts = [
                textOf(yield* call({ action: "add", text: "write tests" })),
                textOf(yield* call({ action: "add", text: "ship" })),
                textOf(yield* call({ action: "done", id: 1 })),
              ];
              const [added] = (yield* Effect.flatMap(Registries, (registries) => registries.items(PromptSections))).filter(
                (contribution) => contribution.pluginId === "todo",
              );
              const section = yield* awaitable(() => added!.item.text({ sessionId: "s", turnId: "t", cwd: "/", model: "p/m", tools: [] }));
              return [texts, section] as const;
            }),
          );
        }),
      ),
    );
    expect(texts).toEqual(["Added #1", "Added #2", "Done #1"]);
    expect(section).toBe("Open items on your todo list (the `todo` tool):\n- #2 ship");
  });
});
