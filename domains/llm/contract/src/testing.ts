/*
 * `@lemma/llm/testing`: the `Llm` contract as a Vitest suite, which a plugin replacing `llm.pi-ai` (or adding a
 * provider) runs to meet the same bar (`llmConformance`), and a scripted model (`scriptedLlm`) for testing a plugin in
 * a real turn. Imports `vitest`: for tests only.
 */
import { Deferred, Effect, Layer, Result, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { definePlugin, Hooks, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { emptyUsage, Llm, LlmError, LlmRequest, LlmRequestHook, StreamEvent, streamThroughHook } from "./llm.ts";
import type { AssistantMessage, ModelInfo, StreamEvent as ModelEvent, ToolCall } from "./llm.ts";

/** What a scripted model plays for one call: the stream a provider would. */
export type Script = Stream.Stream<ModelEvent, LlmError>;

/** The scripted model's one model. */
export const SCRIPTED_MODEL: ModelInfo = {
  ref: "scripted/model",
  provider: "scripted",
  id: "model",
  name: "Scripted model",
  api: "scripted",
  reasoning: false,
  thinkingLevels: [],
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const answer = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: SCRIPTED_MODEL.api,
  provider: SCRIPTED_MODEL.provider,
  model: SCRIPTED_MODEL.id,
  usage: { ...emptyUsage, input: 10, output: 5, totalTokens: 15 },
  stopReason,
  timestamp: 1,
});

/** Answers `text`, ending the turn. */
export const reply = (text: string): Script =>
  Stream.fromIterable<ModelEvent>([
    { type: "start" },
    { type: "text-delta", index: 0, delta: text },
    { type: "done", message: answer([{ type: "text", text }], "stop") },
  ]);

/** A call of the tool `name` with `args`, for `callTools`. */
export const toolCall = (name: string, args: Record<string, unknown>, id = `call-${name}`): ToolCall => ({ type: "toolCall", id, name, arguments: args });

/** Calls the tools, so the turn runs them and asks the model again. */
export const callTools = (...calls: ToolCall[]): Script =>
  Stream.fromIterable<ModelEvent>([
    { type: "start" },
    ...calls.flatMap((call, index): ModelEvent[] => [
      { type: "toolcall-start", index, id: call.id, name: call.name },
      { type: "toolcall-end", index, toolCall: call },
    ]),
    { type: "done", message: answer(calls, "toolUse") },
  ]);

/** Writes `text`, then never ends: for a turn that runs while the test acts. */
export const hang = (text: string): Script =>
  Stream.concat(Stream.fromIterable<ModelEvent>([{ type: "start" }, { type: "text-delta", index: 0, delta: text }]), Stream.never);

/** Plays `script` once `gate` opens. */
export const gated = (gate: Deferred.Deferred<void>, script: Script): Script => Stream.unwrap(Effect.as(Deferred.await(gate), script));

/**
 * A plugin providing `Llm` with one model (`SCRIPTED_MODEL`), which plays `scripts` in order, a call each (a function
 * of the request, for one that answers what it was asked), recording each request; a call past the last fails. It
 * runs `LlmRequestHook` as a provider does. For testing a plugin in a real turn: compose it with the agent, the
 * session log, and the tools, as the agent suite does (`@lemma/agent/testing`).
 */
export const scriptedLlm = (scripts: readonly (Script | ((request: LlmRequest) => Script))[], id = "scripted-llm") => {
  const requests: LlmRequest[] = [];
  const queue = [...scripts];
  const unknown = (ref: string) => Effect.fail(new LlmError({ reason: "UnknownModel", message: `Unknown model ${ref}` }));
  const plugin = definePlugin({
    id,
    provides: [Llm],
    layer: Layer.effect(
      Llm,
      Effect.map(Hooks, (hooks) => ({
        providers: Effect.succeed([]),
        models: () => Effect.succeed([SCRIPTED_MODEL]),
        model: (ref: string) => (ref === SCRIPTED_MODEL.ref ? Effect.succeed(SCRIPTED_MODEL) : unknown(ref)),
        stream: (request: LlmRequest) =>
          streamThroughHook(hooks, request, (asked) =>
            Effect.sync(() => {
              requests.push(asked);
              const next = queue.shift();
              return next === undefined
                ? Stream.fail(new LlmError({ reason: "UnknownModel", message: "no script left" }))
                : typeof next === "function"
                  ? next(asked)
                  : next;
            }),
          ),
        login: () => Effect.void,
        logout: () => Effect.void,
        addCustom: () => Effect.succeed("custom"),
        removeCustom: () => Effect.void,
        setLogo: () => Effect.void,
        classifiers: () => Effect.succeed([]),
        classify: unknown,
      })),
    ),
  });
  return { plugin, requests };
};

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
