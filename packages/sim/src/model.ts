import { Clock, Duration, Effect, Layer, Stream } from "effect";
import { definePlugin } from "@lemma/core";
import { emptyUsage, Llm, LlmError } from "@lemma/llm";
import type { AssistantMessage, LlmFailure, LlmRequest, ModelInfo, StreamEvent, ToolCall, Usage } from "@lemma/llm";
import type { Prng } from "./random.ts";

/** The one model a simulated host offers. */
export const SIM_MODEL = "sim/model";

/** The model's context window: small, so a few large answers fill it and compaction runs. */
export const CONTEXT_WINDOW = 200_000;

const info: ModelInfo = {
  ref: SIM_MODEL,
  provider: "sim",
  id: "model",
  name: "Simulated model",
  api: "sim",
  reasoning: false,
  thinkingLevels: [],
  input: ["text"],
  contextWindow: CONTEXT_WINDOW,
  maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * How often the model fails, each a chance per request, as a provider does: drawn once per run (swarm testing), so a
 * run with many transient failures and one with none both happen.
 */
export interface ModelFaults {
  /** A failure asked again after a while (a provider error, a dropped connection). */
  readonly transient: number;
  /** A rate limit that names its delay. */
  readonly rateLimit: number;
  /** A failure not worth asking again (authentication, quota): the turn ends in error. */
  readonly fatal: number;
  /** The request is longer than the context window: the turn compacts and asks again. */
  readonly overflow: number;
  /** No answer for minutes, then a transient failure, as a provider's stall detection reports it. */
  readonly stall: number;
  /** Some text, then the stream breaks: a transient failure. */
  readonly cut: number;
  /** A tool call whose arguments do not fit its tool's input. */
  readonly malformed: number;
  /** An answer that reports most of the context window used, so the next request compacts. */
  readonly bigUsage: number;
}

export const NO_MODEL_FAULTS: ModelFaults = { transient: 0, rateLimit: 0, fatal: 0, overflow: 0, stall: 0, cut: 0, malformed: 0, bigUsage: 0 };

/** What the model answers a request with, drawn from the run's seed. */
export interface Answer {
  /** Milliseconds before its first event. */
  readonly latencyMs: number;
  /** Text it writes, in deltas, each after its own delay. */
  readonly deltas: readonly { readonly text: string; readonly afterMs: number }[];
  /** How it ends: with its tool calls (none ends the turn), or failing. */
  readonly ending:
    | { readonly kind: "done"; readonly calls: readonly ToolCall[] }
    | { readonly kind: "error"; readonly failure: LlmFailure; readonly message: string };
  readonly usage: Usage;
}

/** How the model answers: `answerAsSimulated` by default. */
export type Answering = (request: LlmRequest, prng: Prng) => Answer;

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

/** The text compaction's request ends with (`context.compaction`'s summary request). */
const SUMMARIZE = "Summarize the conversation above.";

const isSummaryRequest = (request: LlmRequest) => {
  const last = request.messages.at(-1);
  return last?.role === "user" && last.content.some((part) => part.type === "text" && part.text.endsWith(SUMMARIZE));
};

const usage = (input: number): Usage => ({ ...emptyUsage, input, output: 20, totalTokens: input + 20 });

/**
 * Text in a few deltas, and in about a third of its answers calls to up to two of the tools offered; failing as
 * `faults` has it. A summary request (compaction's) gets a summary.
 */
export const answerAsSimulated =
  (faults: ModelFaults): Answering =>
  (request, prng) => {
    const deltas = Array.from({ length: prng.between(1, 5) }, () => ({ text: `${prng.pick(WORDS)} `, afterMs: prng.between(5, 200) }));
    const latencyMs = prng.between(50, 2_000);
    const normal = usage(prng.chance(faults.bigUsage) ? Math.round(CONTEXT_WINDOW * 0.85) : 100 + prng.int(2_000));
    if (isSummaryRequest(request)) {
      return prng.chance(faults.fatal)
        ? { latencyMs, deltas: [], usage: usage(100), ending: { kind: "error", failure: { kind: "fatal" }, message: "The summary failed" } }
        : { latencyMs, deltas, usage: usage(100), ending: { kind: "done", calls: [] } };
    }
    if (prng.chance(faults.fatal))
      return { latencyMs, deltas: [], usage: normal, ending: { kind: "error", failure: { kind: "fatal" }, message: "Invalid API key" } };
    if (prng.chance(faults.overflow)) {
      return {
        latencyMs,
        deltas: [],
        usage: normal,
        ending: { kind: "error", failure: { kind: "overflow" }, message: "The request is longer than the context window" },
      };
    }
    if (prng.chance(faults.transient)) {
      return { latencyMs, deltas: [], usage: normal, ending: { kind: "error", failure: { kind: "transient" }, message: "The provider is overloaded" } };
    }
    if (prng.chance(faults.rateLimit)) {
      const retryAfterMs = prng.between(1_000, 60_000);
      return { latencyMs, deltas: [], usage: normal, ending: { kind: "error", failure: { kind: "rate-limit", retryAfterMs }, message: "Rate limited" } };
    }
    if (prng.chance(faults.stall)) {
      return {
        latencyMs: prng.between(60_000, 300_000),
        deltas: [],
        usage: normal,
        ending: { kind: "error", failure: { kind: "transient" }, message: "The stream stalled" },
      };
    }
    if (prng.chance(faults.cut)) {
      return { latencyMs, deltas, usage: normal, ending: { kind: "error", failure: { kind: "transient" }, message: "The connection was reset" } };
    }
    const offered = (request.tools ?? []).map((tool) => tool.name);
    const calls: ToolCall[] =
      offered.length > 0 && prng.chance(0.35)
        ? Array.from({ length: prng.between(1, 2) }, (_, index) => {
            const name = prng.pick(offered);
            const malformed = prng.chance(faults.malformed);
            return {
              type: "toolCall" as const,
              id: `call-${prng.int(1 << 30).toString(36)}-${index}`,
              name,
              arguments: malformed ? { unexpected: true } : { text: prng.pick(WORDS), steps: prng.between(1, 4) },
            };
          })
        : [];
    return { latencyMs, deltas, usage: normal, ending: { kind: "done", calls } };
  };

/** Text in a few deltas, and now and then calls to the tools offered; never failing. */
export const answerSimply: Answering = answerAsSimulated(NO_MODEL_FAULTS);

const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], used: Usage, timestamp: number, error?: string) => ({
  role: "assistant" as const,
  content,
  api: "sim",
  provider: "sim",
  model: "model",
  usage: used,
  stopReason,
  timestamp,
  ...(error === undefined ? {} : { errorMessage: error }),
});

/** The events of `answer`, each at its time on Effect's clock. */
const play = (answer: Answer): Stream.Stream<StreamEvent> => {
  const text = answer.deltas.map((delta) => delta.text).join("");
  const written: AssistantMessage["content"] = text === "" ? [] : [{ type: "text", text }];
  const at = (millis: number) => Effect.sleep(Duration.millis(millis));
  const { ending } = answer;
  const end = (now: number): StreamEvent[] =>
    ending.kind === "error"
      ? [{ type: "error", message: message(written, "error", answer.usage, now, ending.message), failure: ending.failure }]
      : [
          ...ending.calls.flatMap((toolCall, index): StreamEvent[] => [
            { type: "toolcall-start", index: index + 1, id: toolCall.id, name: toolCall.name },
            { type: "toolcall-end", index: index + 1, toolCall },
          ]),
          { type: "done", message: message([...written, ...ending.calls], ending.calls.length > 0 ? "toolUse" : "stop", answer.usage, now) },
        ];
  return Stream.concat(
    Stream.fromEffect(Effect.as(at(answer.latencyMs), { type: "start" } as StreamEvent)),
    Stream.concat(
      Stream.fromIterable(answer.deltas).pipe(
        Stream.mapEffect((delta) => Effect.as(at(delta.afterMs), { type: "text-delta", index: 0, delta: delta.text } as StreamEvent)),
      ),
      Stream.unwrap(Effect.map(Clock.currentTimeMillis, (now) => Stream.fromIterable(end(now)))),
    ),
  );
};

/** A request the model was asked, and by which host. */
export interface ModelCall {
  readonly host: number;
  readonly request: LlmRequest;
  /** It is compaction's request for a summary, not one of a turn's. */
  readonly summary: boolean;
}

/**
 * A plugin providing `Llm`: the simulated model, answering each request as `answering` draws it from `prng`. Every
 * request it is asked is kept in `calls`, which hosts of a run share, to check against the log.
 */
export const simModel = (prng: Prng, options: { readonly answering?: Answering; readonly host?: number; readonly calls?: ModelCall[] } = {}) => {
  const answering = options.answering ?? answerSimply;
  const calls = options.calls ?? [];
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
            calls.push({ host: options.host ?? 0, request, summary: isSummaryRequest(request) });
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
  return { plugin, calls };
};
