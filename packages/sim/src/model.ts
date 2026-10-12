import { Clock, Duration, Effect, Layer, Stream } from "effect";
import { definePlugin } from "@lemma/core";
import { emptyUsage, Llm, LlmError } from "@lemma/llm";
import type { AssistantMessage, LlmRequest, ModelInfo, StreamEvent, ToolCall } from "@lemma/llm";
import type { Prng } from "./random.ts";

/** The one model a simulated host offers. */
export const SIM_MODEL = "sim/model";

const info: ModelInfo = {
  ref: SIM_MODEL,
  provider: "sim",
  id: "model",
  name: "Simulated model",
  api: "sim",
  reasoning: false,
  thinkingLevels: [],
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** What the model answers a request with, drawn from the run's seed. */
export interface Answer {
  /** Milliseconds before its first event. */
  readonly latencyMs: number;
  /** Text it writes, in deltas, each after its own delay. */
  readonly deltas: readonly { readonly text: string; readonly afterMs: number }[];
  /** Tool calls it makes after the text; none ends the turn. */
  readonly calls: readonly ToolCall[];
}

/** How the model answers: the default draws text and, now and then, calls to the tools the request offers. */
export type Answering = (request: LlmRequest, prng: Prng) => Answer;

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

/** Text in a few deltas; a call to each of up to two offered tools in about a third of its answers. */
export const answerSimply: Answering = (request, prng) => {
  const deltas = Array.from({ length: prng.between(1, 5) }, () => ({ text: `${prng.pick(WORDS)} `, afterMs: prng.between(5, 200) }));
  const offered = (request.tools ?? []).map((tool) => tool.name);
  const calls: ToolCall[] =
    offered.length > 0 && prng.chance(0.35)
      ? Array.from({ length: prng.between(1, 2) }, (_, index) => ({
          type: "toolCall" as const,
          id: `call-${prng.int(1 << 30).toString(36)}-${index}`,
          name: prng.pick(offered),
          arguments: { text: prng.pick(WORDS) },
        }))
      : [];
  return { latencyMs: prng.between(50, 2_000), deltas, calls };
};

const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], timestamp: number): AssistantMessage => ({
  role: "assistant",
  content,
  api: "sim",
  provider: "sim",
  model: "model",
  usage: { ...emptyUsage, input: 100, output: 20, totalTokens: 120 },
  stopReason,
  timestamp,
});

/** The events of `answer`, each at its time on Effect's clock. */
const play = (answer: Answer): Stream.Stream<StreamEvent> => {
  const text = answer.deltas.map((delta) => delta.text).join("");
  const content: AssistantMessage["content"] = [...(text === "" ? [] : [{ type: "text" as const, text }]), ...answer.calls];
  const at = (millis: number) => Effect.sleep(Duration.millis(millis));
  return Stream.concat(
    Stream.fromEffect(Effect.as(at(answer.latencyMs), { type: "start" } as StreamEvent)),
    Stream.concat(
      Stream.fromIterable(answer.deltas).pipe(
        Stream.mapEffect((delta) => Effect.as(at(delta.afterMs), { type: "text-delta", index: 0, delta: delta.text } as StreamEvent)),
      ),
      Stream.unwrap(
        Effect.map(Clock.currentTimeMillis, (now) =>
          Stream.fromIterable<StreamEvent>([
            ...answer.calls.flatMap((toolCall, index): StreamEvent[] => [
              { type: "toolcall-start", index: index + 1, id: toolCall.id, name: toolCall.name },
              { type: "toolcall-end", index: index + 1, toolCall },
            ]),
            { type: "done", message: message(content, answer.calls.length > 0 ? "toolUse" : "stop", now) },
          ]),
        ),
      ),
    ),
  );
};

/** A plugin providing `Llm`: the simulated model, answering each request as `answering` draws it from `prng`. */
export const simModel = (prng: Prng, answering: Answering = answerSimply) => {
  const requests: LlmRequest[] = [];
  const plugin = definePlugin({
    id: "sim.model",
    provides: [Llm],
    layer: Layer.succeed(Llm, {
      providers: Effect.succeed([]),
      models: () => Effect.succeed([info]),
      model: (ref) => (ref === SIM_MODEL ? Effect.succeed(info) : Effect.fail(new LlmError({ reason: "UnknownModel", message: `Unknown model ${ref}` }))),
      stream: (request) =>
        Stream.unwrap(
          Effect.sync(() => {
            requests.push(request);
            return play(answering(request, prng));
          }),
        ),
      login: () => Effect.void,
      logout: () => Effect.void,
      addCustom: () => Effect.succeed("sim"),
      removeCustom: () => Effect.void,
      setLogo: () => Effect.void,
    }),
  });
  return { plugin, requests };
};
