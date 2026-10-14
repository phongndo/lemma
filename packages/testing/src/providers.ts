import { Deferred, Effect, Fiber, Result, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Llm, LlmRequest, LlmRequestHook, StreamEvent } from "@lemma/llm";
import type { StreamEvent as ModelEvent } from "@lemma/llm";
import { ToolInvocation, ToolResult, ToolRunner, Tools } from "@lemma/tools";
import type { Tool } from "@lemma/tools";

/** Checks stream grammar and deltas against the terminal message, independently of provider adapters. */
export function streamProblems(events: readonly unknown[]): string[] {
  const problems: string[] = [];
  const decode = Schema.decodeUnknownResult(StreamEvent);
  const valid: ModelEvent[] = [];
  for (const [index, event] of events.entries()) {
    const decoded = decode(event);
    if (Result.isFailure(decoded)) problems.push(`event ${index}: invalid shape`);
    else valid.push(decoded.success);
  }
  if (valid[0]?.type !== "start") problems.push("stream did not start");
  if (valid.filter((event) => event.type === "start").length !== 1) problems.push("stream must start once");
  const terminals = valid.filter((event) => event.type === "done" || event.type === "error");
  if (terminals.length !== 1 || valid.at(-1) !== terminals[0]) problems.push("stream must end with one terminal");
  const text = new Map<number, string>();
  for (const event of valid) if (event.type === "text-delta") text.set(event.index, (text.get(event.index) ?? "") + event.delta);
  const last = terminals[0];
  if (last !== undefined)
    for (const [index, written] of text) {
      const block = last.message.content[index];
      if (block?.type !== "text" || block.text !== written) problems.push(`text block ${index} differs from deltas`);
    }
  const ids = new Set<string>();
  for (const event of valid)
    if (event.type === "toolcall-start") {
      if (ids.has(event.id)) problems.push(`duplicate tool call ${event.id}`);
      ids.add(event.id);
    }
  return problems;
}

export interface LlmFixture {
  readonly plugins: readonly Plugin[];
  readonly model: string;
  /** The controlled provider transport saw its request aborted. */
  readonly aborted: () => boolean;
}

/**
 * Registers the `Llm` contract as Vitest tests, against the provider `compose` returns for each case, which answers
 * any request so: `reply`, the text "Hello there" and a call `call-1` of `echo` with `{ text: "x" }`; `failure`, an
 * `error` terminal with some partial text; `abort`, an answer still streaming after its first two events, when the
 * suite closes the stream, which must abort the provider's request (`aborted`).
 */
export function llmConformance(name: string, compose: (scenario: "reply" | "failure" | "abort") => LlmFixture | Promise<LlmFixture>): void {
  describe(`Llm contract: ${name}`, () => {
    const run = async <A>(
      scenario: "reply" | "failure" | "abort",
      body: (service: typeof Llm.Service, request: LlmRequest) => Effect.Effect<A, unknown>,
      /** The suite's handler of `LlmRequestHook` hands `next` another model's request, as the contract forbids. */
      changes = false,
    ) => {
      const fixture = await compose(scenario);
      let hooked = 0;
      const observer = definePlugin({
        id: "llm.conformance",
        setup: function* () {
          yield* (yield* PluginContext).on(LlmRequestHook, (request, next) =>
            Effect.andThen(
              Effect.sync(() => hooked++),
              next(changes ? new LlmRequest({ ...request, model: "conformance/other" }) : request),
            ),
          );
        },
      });
      const value = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([...fixture.plugins, observer]);
            return yield* core.run(
              Effect.gen(function* () {
                const llm = yield* Llm;
                const request = new LlmRequest({
                  model: fixture.model,
                  messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
                  tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } } } }],
                });
                return yield* body(llm, request);
              }),
            );
          }),
        ),
      );
      return { value, hooked, fixture };
    };
    test("catalog resolves a model and refuses an unknown one", async () => {
      const { value } = await run("reply", (llm, request) =>
        Effect.gen(function* () {
          expect((yield* llm.model(request.model)).ref).toBe(request.model);
          expect((yield* llm.models()).some((model) => model.ref === request.model)).toBe(true);
          return yield* Effect.result(llm.model("missing/no-model"));
        }),
      );
      expect(Result.isFailure(value) && value.failure.reason).toBe("UnknownModel");
    });
    test("a reply has one terminal, exact text and a complete tool call, through the request hook", async () => {
      const { value, hooked } = await run("reply", (llm, request) => Stream.runCollect(llm.stream(request)));
      expect(streamProblems(value)).toEqual([]);
      expect(
        value
          .filter((event) => event.type === "text-delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe("Hello there");
      expect(value.find((event) => event.type === "toolcall-end")).toMatchObject({ toolCall: { id: "call-1", name: "echo", arguments: { text: "x" } } });
      expect(hooked).toBe(1);
    });
    test("a request a handler of the request hook changed fails the stream Hook, naming the handler", async () => {
      const { value, hooked } = await run("reply", (llm, request) => Effect.result(Stream.runCollect(llm.stream(request))), true);
      expect(hooked).toBe(1);
      expect(Result.isFailure(value) && value.failure).toMatchObject({ _tag: "LlmError", reason: "Hook", message: expect.stringContaining("llm.conformance") });
    });
    test("a provider failure is a terminal event with the partial response", async () => {
      const { value } = await run("failure", (llm, request) => Stream.runCollect(llm.stream(request)));
      expect(streamProblems(value)).toEqual([]);
      expect(value.at(-1)).toMatchObject({ type: "error", message: { stopReason: "error" } });
    });
    test("closing the consumer aborts the underlying request", async () => {
      const { value, fixture } = await run("abort", (llm, request) => Stream.runCollect(llm.stream(request).pipe(Stream.take(2))));
      expect(value).toHaveLength(2);
      expect(fixture.aborted()).toBe(true);
    });
  });
}

/** Registers the `ToolRunner` contract as Vitest tests, against the plugins `compose` returns, with tools of its own. */
export function toolsConformance(name: string, compose: () => readonly Plugin[] | Promise<readonly Plugin[]>): void {
  describe(`ToolRunner contract: ${name}`, () => {
    const echo: Tool<{ text: string }> = {
      name: "conformance.echo",
      description: "Echo",
      input: Schema.Struct({ text: Schema.String }),
      execute: ({ text }, context) => {
        context.update?.("one");
        context.update?.("two");
        return new ToolResult({ content: [{ type: "text", text }] });
      },
    };
    const broken: Tool = { ...echo, name: "conformance.fail", execute: () => Effect.fail("test failure") };
    const run = async <A>(body: (runner: typeof ToolRunner.Service) => Effect.Effect<A, unknown>) => {
      const plugins = await compose();
      const contributor = definePlugin({
        id: "tools.conformance",
        setup: function* () {
          const owner = yield* PluginContext;
          yield* owner.add(Tools, echo);
          yield* owner.add(Tools, broken);
        },
      });
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([...plugins, contributor]);
            return yield* core.run(Effect.flatMap(ToolRunner, body));
          }),
        ),
      );
    };
    const invocation = (name: string, input: unknown) => new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: "/work" });
    test("lists attribution and returns execution and validation errors as results", async () =>
      run((runner) =>
        Effect.gen(function* () {
          const listed = (yield* runner.list).find((tool) => tool.spec.name === echo.name);
          expect(listed?.source).toBe("tools.conformance");
          expect(listed?.spec.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
          expect((yield* runner.execute(invocation(echo.name, { text: "ok" }), new AbortController().signal)).content).toEqual([{ type: "text", text: "ok" }]);
          expect((yield* runner.execute(invocation(echo.name, { text: 3 }), new AbortController().signal)).isError).toBe(true);
          expect((yield* runner.execute(invocation(broken.name, { text: "ok" }), new AbortController().signal)).isError).toBe(true);
          const unknown = yield* Effect.result(runner.execute(invocation("missing", {}), new AbortController().signal));
          expect(Result.isFailure(unknown) && unknown.failure.reason).toBe("NotFound");
        }),
      ));
    test("all output reaches the caller in order before the result, including an Effect listener", async () =>
      run((runner) =>
        Effect.gen(function* () {
          const heard: string[] = [];
          yield* runner.execute(invocation(echo.name, { text: "ok" }), new AbortController().signal, {
            update: (chunk) =>
              Effect.andThen(
                Effect.yieldNow,
                Effect.sync(() => heard.push(chunk)),
              ),
          });
          heard.push("result");
          expect(heard.slice(0, -1).join("")).toBe("onetwo");
          expect(heard.at(-1)).toBe("result");
        }),
      ));
    test("an already aborted invocation does not run", async () =>
      run((runner) =>
        Effect.gen(function* () {
          const signal = new AbortController();
          signal.abort();
          const result = yield* Effect.result(runner.execute(invocation(echo.name, { text: "ok" }), signal.signal));
          expect(Result.isFailure(result) && result.failure.reason).toBe("Cancelled");
        }),
      ));
    test("aborting a running invocation interrupts its tool, even with a blocked listener", async () => {
      const began = Effect.runSync(Deferred.make<void>());
      let interrupted = false;
      const slow = definePlugin({
        id: "tools.slow",
        setup: function* () {
          yield* (yield* PluginContext).add(Tools, {
            name: "conformance.slow",
            description: "Slow",
            input: Schema.Unknown,
            execute: (_input, context) => {
              context.update?.("started");
              return Effect.andThen(Deferred.succeed(began, undefined), Effect.never).pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))));
            },
          });
        },
      });
      const plugins = await compose();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([...plugins, slow]);
            yield* core.run(
              Effect.gen(function* () {
                const controller = new AbortController();
                const runner = yield* ToolRunner;
                const running = yield* Effect.forkChild(
                  Effect.result(runner.execute(invocation("conformance.slow", {}), controller.signal, { update: () => Effect.never })),
                );
                yield* Deferred.await(began);
                controller.abort();
                const result = yield* Fiber.join(running);
                expect(Result.isFailure(result) && result.failure.reason).toBe("Cancelled");
                expect(interrupted).toBe(true);
              }),
            );
          }),
        ),
      );
    });
  });
}
