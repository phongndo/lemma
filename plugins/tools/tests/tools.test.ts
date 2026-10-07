import { Cause, Context, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { CoreClosed, definePlugin, Events, makeCore, PluginContext, Registries } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Inspectors, snapshotOf, ToolExecuted, ToolExecuteHook, ToolInvocation, ToolOutput, ToolResult, Tools } from "@lemma/contracts";
import type { Guard, Tool } from "@lemma/contracts";
import tools, { toolParameters } from "../src/index.ts";
import { outputBatcher } from "../src/registry.ts";

const ok = (text: string) => new ToolResult({ content: [{ type: "text", text }] });
const textOf = (result: ToolResult) => result.content.map((part) => (part.type === "text" ? part.text : "<image>")).join("");

const echo: Tool<{ readonly text: string }> = {
  name: "echo",
  description: "Echoes text.",
  input: Schema.Struct({ text: Schema.String.annotate({ description: "What to say" }) }),
  execute: async ({ text }) => ok(text),
};

const contributor = (id: string, contributed: readonly Tool<any>[], guards: readonly [string, Guard][] = []) =>
  definePlugin({
    id,
    requires: [Tools],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const registry = yield* Tools;
        for (const tool of contributed) yield* registry.register(tool);
        for (const [name, guard] of guards) yield* registry.guard(name, guard);
      }),
    ),
  });

const call = (name: string, input: unknown, signal = new AbortController().signal) =>
  Effect.flatMap(Tools, (registry) => registry.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c1", name, input, cwd: "/tmp" }), signal));

const run = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Tools | Events>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, ...plugins]);
        return yield* core.run(body);
      }),
    ),
  );

describe("registry", () => {
  it("shows its tools and guards to the devtools and `lemma inspect`, each with the plugin that added it", async () => {
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([tools, contributor("mine", [echo], [["echo", () => Effect.succeed({ _tag: "allow" as const })]])]);
          const inspectors = yield* core.run(Effect.flatMap(Registries, (registries) => registries.items(Inspectors)));
          const found = inspectors.find((contribution) => contribution.item.id === "tools.registered");
          expect(found?.pluginId).toBe("tools");
          return yield* snapshotOf(found!.item);
        }),
      ),
    );
    expect(snapshot).toEqual({ tools: [{ name: "echo", plugin: "mine", description: "Echoes text." }], guards: [{ tool: "echo", plugin: "mine" }] });
  });

  it("lists tools by name with the registering plugin as source and clean schemas", async () => {
    const Point = Schema.Struct({ x: Schema.Number }).annotate({ identifier: "Point" });
    const shapes: Tool<any> = {
      name: "shapes",
      description: "d",
      input: Schema.Struct({
        count: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description: "How many" })),
        points: Schema.Array(Point),
      }),
      replay: "safe",
      parallel: "safe",
      execute: async () => ok(""),
    };
    const listed = await run(
      [contributor("mine", [shapes, echo])],
      Effect.flatMap(Tools, (registry) => registry.list),
    );
    expect(listed.map((tool) => [tool.spec.name, tool.source])).toEqual([
      ["echo", "mine"],
      ["shapes", "mine"],
    ]);
    expect(listed.map((tool) => [tool.replay, tool.parallel])).toEqual([
      [undefined, undefined],
      ["safe", "safe"],
    ]);
    const parameters = listed[1]!.spec.parameters;
    expect(JSON.stringify(parameters)).not.toMatch(/\$schema|\$ref|\$defs|"title"/);
    expect(parameters).toEqual({
      type: "object",
      required: ["points"],
      properties: {
        count: { type: "integer", description: "How many", exclusiveMinimum: 0 },
        points: { type: "array", items: { type: "object", required: ["x"], properties: { x: { type: "number" } }, additionalProperties: false } },
      },
      additionalProperties: false,
    });
  });

  it("gives non-object inputs an object root", () => {
    expect(toolParameters(Schema.Unknown)).toEqual({ type: "object", properties: {} });
  });

  it("rejects a duplicate name, failing the second contributor", async () => {
    const failure = await Effect.runPromise(Effect.scoped(Effect.flip(makeCore([tools, contributor("a", [echo]), contributor("b", [echo])]))));
    expect(String(JSON.stringify(failure))).toContain("already registered by a");
  });

  it("removes a tool when its registering scope closes", async () => {
    // A tool is attributed to the plugin registering it: this one lends its context to the test.
    let captured: Context.Service.Shape<typeof PluginContext> | undefined;
    const lender = definePlugin({
      id: "temp",
      layer: Layer.effectDiscard(
        Effect.map(PluginContext, (context) => {
          captured = context;
        }),
      ),
    });
    await run(
      [lender],
      Effect.gen(function* () {
        const registry = yield* Tools;
        const scope = yield* Scope.make();
        yield* registry.register(echo).pipe(Effect.provideService(PluginContext, captured!), Scope.provide(scope));
        expect((yield* registry.list).map((tool) => tool.source)).toEqual(["temp"]);
        yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
        expect(yield* registry.list).toEqual([]);
      }),
    );
  });

  it("lifts a guard when its installing scope closes", async () => {
    let captured: Context.Service.Shape<typeof PluginContext> | undefined;
    const lender = definePlugin({
      id: "plan-mode",
      layer: Layer.effectDiscard(
        Effect.map(PluginContext, (context) => {
          captured = context;
        }),
      ),
    });
    await run(
      [contributor("p", [echo]), lender],
      Effect.gen(function* () {
        const registry = yield* Tools;
        const scope = yield* Scope.make();
        yield* registry
          .guard("echo", () => Effect.succeed({ _tag: "deny", reason: "plan mode" }))
          .pipe(Effect.provideService(PluginContext, captured!), Scope.provide(scope));
        expect(textOf(yield* call("echo", { text: "hi" }))).toBe("Tool call denied: plan mode");
        yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
        expect(textOf(yield* call("echo", { text: "hi" }))).toBe("hi");
      }),
    );
  });
});

describe("execute", () => {
  it("returns results, validation errors, and tool failures as results; unknown tools fail", async () => {
    const throwing: Tool<unknown> = {
      name: "throws",
      description: "",
      input: Schema.Unknown,
      execute: () => {
        throw new Error("boom");
      },
    };
    const failing: Tool<unknown> = { name: "fails", description: "", input: Schema.Unknown, execute: () => Effect.fail(new Error("effect failed")) };
    const rejecting: Tool<unknown> = {
      name: "rejects",
      description: "",
      input: Schema.Unknown,
      execute: async () => {
        throw new Error("rejected");
      },
    };
    const malformed: Tool<unknown> = { name: "malformed", description: "", input: Schema.Unknown, execute: async () => ({ nope: 1 }) as never };
    // A tool may return its result at once, with no promise or Effect.
    const immediate: Tool<unknown> = { name: "immediate", description: "", input: Schema.Unknown, execute: () => ok("at once") };
    await run(
      [contributor("p", [echo, throwing, failing, rejecting, malformed, immediate])],
      Effect.gen(function* () {
        expect(textOf(yield* call("echo", { text: "hi" }))).toBe("hi");
        const invalid = yield* call("echo", { text: 1 });
        expect(invalid.isError).toBe(true);
        expect(textOf(invalid)).toContain('Validation failed for tool "echo"');
        expect(textOf(yield* call("throws", {}))).toBe("boom");
        expect(textOf(yield* call("fails", {}))).toBe("effect failed");
        expect(textOf(yield* call("rejects", {}))).toBe("rejected");
        expect(textOf(yield* call("malformed", {}))).toContain("invalid result");
        expect(textOf(yield* call("immediate", {}))).toBe("at once");
        const missing = yield* Effect.flip(call("nope", {}));
        expect(missing.reason).toBe("NotFound");
        expect(missing.message).toContain("Available tools: echo");
      }),
    );
  });

  it("runs guards after every hook handler; any deny wins and is scoped by tool name", async () => {
    const seen: string[] = [];
    const rewriter = definePlugin({
      id: "rewriter",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(ToolExecuteHook, (invocation, next) => {
            seen.push(`hook:${JSON.stringify(invocation.input)}`);
            return next(new ToolInvocation({ ...invocation, input: { text: "rewritten" } }));
          });
        }),
      ),
    });
    const guards: [string, Guard][] = [
      [
        "*",
        (invocation) =>
          Effect.sync(() => {
            seen.push(`guard:${JSON.stringify(invocation.input)}`);
            return { _tag: "allow" };
          }),
      ],
      [
        "echo",
        (invocation) =>
          Effect.succeed((invocation.input as { text: string }).text === "rewritten" ? { _tag: "deny", reason: "no rewrites" } : { _tag: "allow" }),
      ],
      ["other", () => Effect.succeed({ _tag: "deny", reason: "never applies to echo" })],
    ];
    await run(
      [contributor("p", [echo], guards), rewriter],
      Effect.gen(function* () {
        const result = yield* call("echo", { text: "original" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe("Tool call denied: no rewrites");
        expect(result.details).toEqual({ deniedBy: "p" });
        expect(seen).toEqual(['hook:{"text":"original"}', 'guard:{"text":"rewritten"}']);
      }),
    );
  });

  it("re-validates input a handler rewrote", async () => {
    const breaker = definePlugin({
      id: "breaker",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(ToolExecuteHook, (invocation, next) => next(new ToolInvocation({ ...invocation, input: { text: 42 } }))),
        ),
      ),
    });
    await run(
      [contributor("p", [echo]), breaker],
      Effect.gen(function* () {
        const result = yield* call("echo", { text: "fine" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Validation failed");
      }),
    );
  });

  it("reports a core shutting down under a call as a defect, not a result the model would read", async () => {
    const closing = definePlugin({
      id: "closing",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(ToolExecuteHook, () => Effect.fail(new CoreClosed())))),
    });
    await run(
      [contributor("p", [echo]), closing],
      Effect.gen(function* () {
        const exit = yield* Effect.exit(call("echo", { text: "fine" }));
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && Cause.squash(exit.cause)).toBeInstanceOf(CoreClosed);
      }),
    );
  });

  it("aborts a promise tool through its signal and interrupts an Effect tool", async () => {
    let promiseAborted = false;
    let effectInterrupted = false;
    const slowPromise: Tool<unknown> = {
      name: "slow-promise",
      description: "",
      input: Schema.Unknown,
      execute: (_, context) =>
        new Promise<ToolResult>(() => {
          context.signal.addEventListener("abort", () => {
            promiseAborted = true;
          });
        }),
    };
    const slowEffect: Tool<unknown> = {
      name: "slow-effect",
      description: "",
      input: Schema.Unknown,
      execute: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              effectInterrupted = true;
            }),
          ),
        ),
    };
    await run(
      [contributor("p", [slowPromise, slowEffect])],
      Effect.gen(function* () {
        for (const name of ["slow-promise", "slow-effect"]) {
          const controller = new AbortController();
          const fiber = yield* Effect.forkChild(call(name, {}, controller.signal));
          yield* Effect.sleep(10);
          controller.abort();
          const error = yield* Effect.flip(Fiber.join(fiber));
          expect(error.reason).toBe("Cancelled");
        }
        expect(promiseAborted).toBe(true);
        expect(effectInterrupted).toBe(true);
      }),
    );
  });

  it("truncates long text and publishes ToolExecuted", async () => {
    const long: Tool<unknown> = { name: "long", description: "", input: Schema.Unknown, execute: async () => ok("x".repeat(50)) };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([tools, contributor("p", [long])], { configs: { tools: { maxResultChars: 10 } } });
          yield* core.run(
            Effect.gen(function* () {
              const events = yield* Events;
              const executed = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(ToolExecuted), 1)));
              yield* Effect.yieldNow;
              const result = yield* call("long", {});
              expect(textOf(result)).toBe(`${"x".repeat(10)}\n\n[Output truncated: showing 10 of 50 characters]`);
              const [payload] = Array.from(yield* Fiber.join(executed));
              expect(payload!.invocation.name).toBe("long");
              expect(payload!.result).toEqual(result);
            }),
          );
        }),
      ),
    );
  });

  it("publishes a running tool's output as ToolOutput, batched, before its result", async () => {
    const chatty: Tool<unknown> = {
      name: "chatty",
      description: "",
      input: Schema.Unknown,
      execute: async (_input, { update }) => {
        update?.("one\n");
        update?.("two\n");
        await new Promise((resolve) => setTimeout(resolve, 80));
        update?.("three\n");
        return ok("done");
      },
    };
    await run(
      [contributor("p", [chatty])],
      Effect.gen(function* () {
        const events = yield* Events;
        const outputs = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(ToolOutput), 2)));
        yield* Effect.yieldNow;
        expect(textOf(yield* call("chatty", {}))).toBe("done");
        const chunks = Array.from(yield* Fiber.join(outputs));
        expect(chunks.map((payload) => payload.chunk)).toEqual(["one\ntwo\n", "three\n"]);
        expect(chunks.map((payload) => payload.offset)).toEqual([0, 8]);
        expect(chunks[0]).toMatchObject({ sessionId: "s", toolCallId: "c1" });
      }),
    );
  });

  it("refuses a tool the request did not offer, and tells the tool what was offered and the result cap", async () => {
    const context: Tool<unknown> = {
      name: "context",
      description: "",
      input: Schema.Unknown,
      execute: async (_input, { offered, maxResultChars }) => ok(JSON.stringify({ offered, maxResultChars })),
    };
    await run(
      [contributor("p", [context])],
      Effect.gen(function* () {
        const registry = yield* Tools;
        const invoke = (offered: readonly string[]) =>
          registry.execute(
            new ToolInvocation({ sessionId: "s", toolCallId: "c1", name: "context", input: {}, cwd: "/tmp", offered }),
            new AbortController().signal,
          );
        const refused = yield* Effect.flip(invoke(["read"]));
        expect(refused.reason).toBe("NotFound");
        expect(refused.message).toContain("Available tools: read");
        expect(JSON.parse(textOf(yield* invoke(["context", "read"])))).toEqual({ offered: ["context", "read"], maxResultChars: 100_000 });
      }),
    );
  });

  it("sends a call's output to the caller's update instead of publishing it", async () => {
    const chatty: Tool<unknown> = {
      name: "chatty",
      description: "",
      input: Schema.Unknown,
      execute: async (_input, { update }) => {
        update?.("one\n");
        update?.("two\n");
        return ok("done");
      },
    };
    await run(
      [contributor("p", [chatty])],
      Effect.gen(function* () {
        const events = yield* Events;
        const published: unknown[] = [];
        const watching = yield* Effect.forkChild(Stream.runForEach(events.stream(ToolOutput), (payload) => Effect.sync(() => published.push(payload))));
        yield* Effect.yieldNow;
        const received: string[] = [];
        const registry = yield* Tools;
        const result = yield* registry.execute(
          new ToolInvocation({ sessionId: "s", toolCallId: "c1", name: "chatty", input: {}, cwd: "/tmp" }),
          new AbortController().signal,
          { update: (chunk) => void received.push(chunk) },
        );
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(watching);
        expect(textOf(result)).toBe("done");
        expect(received).toEqual(["one\n", "two\n"]);
        expect(published).toEqual([]);
      }),
    );
  });

  it("runs a caller's update as a listener: an Effect it returns runs, and its failures never reach the tool", async () => {
    const chatty: Tool<unknown> = {
      name: "chatty",
      description: "",
      input: Schema.Unknown,
      execute: async (_input, { update }) => {
        for (const chunk of ["effect", "rejects", "throws", "fails"]) update?.(chunk);
        return ok("done");
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await run(
        [contributor("p", [chatty])],
        Effect.gen(function* () {
          const received: string[] = [];
          const registry = yield* Tools;
          const result = yield* registry.execute(
            new ToolInvocation({ sessionId: "s", toolCallId: "c1", name: "chatty", input: {}, cwd: "/tmp" }),
            new AbortController().signal,
            {
              update: (chunk) => {
                if (chunk === "effect") return Effect.sync(() => void received.push(chunk));
                if (chunk === "rejects") return Promise.reject(new Error("listener rejected"));
                if (chunk === "fails") return Effect.fail(new Error("listener failed"));
                throw new Error("listener threw");
              },
            },
          );
          expect(textOf(result)).toBe("done");
          expect(received).toEqual(["effect"]);
        }),
      );
      // The turn after: an unhandled rejection would have been reported by now.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the tail of output that floods between publishes, its offset counting what was dropped", () => {
    const published: { chunk: string; offset: number }[] = [];
    const batcher = outputBatcher((chunk, offset) => published.push({ chunk, offset }), 1_000);
    batcher.update("a".repeat(70_000));
    batcher.update("end");
    batcher.flush();
    expect(published).toHaveLength(1);
    expect(published[0]!.chunk.length).toBe(64 * 1024);
    expect(published[0]!.chunk.endsWith("end")).toBe(true);
    expect(published[0]!.offset).toBe(70_003 - 64 * 1024);
  });
});
