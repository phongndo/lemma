import { Cause, Effect, Layer, Schema, Stream } from "effect";
import { expect, test } from "vitest";
import { awaitable, definePlugin, Hooks, Registries } from "@lemma/core";
import { emptyUsage, Llm, LlmError, streamThroughHook } from "@lemma/llm";
import type { AssistantMessage, ModelInfo, StreamEvent } from "@lemma/llm";
import { ToolError, ToolResult, ToolRunner, Tools } from "@lemma/tools";
import { llmConformance, streamProblems, toolsConformance } from "../src/providers.ts";

// These replacements use contracts only, so the suite cannot silently depend on bundled provider internals.
const info: ModelInfo = {
  ref: "reference/m",
  id: "m",
  provider: "reference",
  name: "Reference",
  api: "reference",
  reasoning: false,
  thinkingLevels: [],
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "reference",
  provider: "reference",
  model: "m",
  usage: emptyUsage,
  stopReason,
  timestamp: 1,
});
llmConformance("independent replacement", (scenario) => {
  let aborted = false;
  const events: StreamEvent[] = [{ type: "start" }, { type: "text-delta", index: 0, delta: scenario === "failure" ? "partial" : "Hello there" }];
  if (scenario === "failure") events.push({ type: "error", message: message([{ type: "text", text: "partial" }], "error"), failure: { kind: "fatal" } });
  if (scenario === "reply") {
    const toolCall = { type: "toolCall" as const, id: "call-1", name: "echo", arguments: { text: "x" } };
    events.push(
      { type: "toolcall-start", index: 1, id: toolCall.id, name: toolCall.name },
      { type: "toolcall-end", index: 1, toolCall },
      { type: "done", message: message([{ type: "text", text: "Hello there" }, toolCall], "toolUse") },
    );
  }
  const plugin = definePlugin({
    id: "reference.llm",
    provides: [Llm],
    layer: Layer.effect(
      Llm,
      Effect.map(Hooks, (hooks) => ({
        providers: Effect.succeed([]),
        models: () => Effect.succeed([info]),
        model: (ref) => (ref === info.ref ? Effect.succeed(info) : Effect.fail(new LlmError({ reason: "UnknownModel", message: ref }))),
        stream: (request) =>
          streamThroughHook(hooks, request, () =>
            Effect.succeed(
              (scenario === "abort" ? Stream.concat(Stream.fromIterable(events), Stream.never) : Stream.fromIterable(events)).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    if (scenario === "abort") aborted = true;
                  }),
                ),
              ),
            ),
          ),
        login: () => Effect.void,
        logout: () => Effect.void,
        addCustom: () => Effect.succeed("reference"),
        removeCustom: () => Effect.void,
        setLogo: () => Effect.void,
        classifiers: () => Effect.succeed([]),
        classify: (ref) => Effect.fail(new LlmError({ reason: "UnknownModel", message: `Unknown model ${ref}` })),
      })),
    ),
  });
  return { plugins: [plugin], model: info.ref, aborted: () => aborted };
});

const errorResult = (error: unknown) => new ToolResult({ content: [{ type: "text", text: String(error) }], isError: true });
toolsConformance("independent replacement", () => [
  definePlugin({
    id: "reference.tools",
    provides: [ToolRunner],
    layer: Layer.effect(
      ToolRunner,
      Effect.map(Registries, (registries) => ({
        list: Effect.map(registries.items(Tools), (items) =>
          items.map(({ item, pluginId }) => ({
            source: pluginId,
            spec: { name: item.name, description: item.description, parameters: Schema.toJsonSchemaDocument(item.input).schema },
          })),
        ),
        execute: (call, signal, options) =>
          Effect.gen(function* () {
            const item = (yield* registries.items(Tools)).find(({ item }) => item.name === call.name)?.item;
            if (item === undefined) return yield* new ToolError({ tool: call.name, reason: "NotFound", message: call.name });
            const cancelled = () => new ToolError({ tool: call.name, reason: "Cancelled", message: call.name });
            if (signal.aborted) return yield* cancelled();
            const chunks: string[] = [];
            const work = Schema.decodeUnknownEffect(item.input)(call.input).pipe(
              Effect.flatMap((input) =>
                awaitable(() =>
                  item.execute(input, {
                    sessionId: call.sessionId,
                    toolCallId: call.toolCallId,
                    cwd: call.cwd,
                    signal,
                    maxResultChars: 100000,
                    update: (chunk) => chunks.push(chunk),
                  }),
                ),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed(errorResult(Cause.squash(cause))),
              ),
              Effect.tap(() =>
                Effect.forEach(chunks, (chunk) => (options?.update === undefined ? Effect.void : awaitable(() => options.update!(chunk)).pipe(Effect.ignore))),
              ),
            );
            const abort = Effect.callback<never, ToolError>((resume) => {
              const ended = () => resume(Effect.fail(cancelled()));
              if (signal.aborted) {
                ended();
                return;
              }
              signal.addEventListener("abort", ended, { once: true });
              return Effect.sync(() => signal.removeEventListener("abort", ended));
            });
            return yield* Effect.raceFirst(work, abort);
          }),
      })),
    ),
  }),
]);

test("the shared stream checker rejects broken provider fixtures", () => {
  const done: StreamEvent = { type: "done", message: message([{ type: "text", text: "wrong" }], "stop") };
  expect(streamProblems([{ type: "start" }, { type: "text-delta", index: 0, delta: "sent" }, done, done])).toEqual([
    "stream must end with one terminal",
    "text block 0 differs from deltas",
  ]);
  expect(
    streamProblems([
      { type: "start" },
      { type: "toolcall-start", index: 0, id: "duplicate", name: "echo" },
      { type: "toolcall-start", index: 1, id: "duplicate", name: "echo" },
      done,
    ]),
  ).toContain("duplicate tool call duplicate");
});
