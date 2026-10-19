/**
 * `@lemma/tools/testing`: calls a tool as the registry would, without a registry, for a tool's own tests; and the
 * `ToolRunner` contract as a Vitest suite, which a plugin replacing `tools.registry` runs (`toolsConformance`). The
 * suite imports `vitest`: for tests only.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { ToolInvocation, ToolResult, ToolRunner, Tools } from "./tools.ts";
import type { Tool, ToolContext } from "./tools.ts";

/** A call's context in `cwd`, with a signal nothing aborts unless given one. */
export const context = (cwd: string, signal: AbortSignal = new AbortController().signal): ToolContext => ({ sessionId: "s", toolCallId: "c", cwd, signal });

/** Calls a tool directly, decoding input with its schema as the registry would. */
export const call = async <I>(tool: Tool<I>, input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  const decoded = Schema.decodeUnknownSync(tool.input)(input);
  const output = tool.execute(decoded, ctx);
  return Effect.isEffect(output) ? Effect.runPromise(output as Effect.Effect<ToolResult>) : output;
};

/** Like `call`, but a throw becomes the message, as the registry reports it to the model. */
export const attempt = async <I>(tool: Tool<I>, input: unknown, ctx: ToolContext): Promise<string> =>
  call(tool, input, ctx).then(
    (result) => `ok: ${textOf(result)}`,
    (error: Error) => `error: ${error.message}`,
  );

/** A result's text, an image as `<image type>`. */
export const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === "text" ? part.text : `<image ${part.mimeType}>`)).join("\n");

/** A new, empty directory for a test to work in. */
export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "lemma-tools-"));

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
