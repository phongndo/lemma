import { Effect, Schema, Stream } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { Notice } from "@lemma/contracts";
import { AgentContinueHook, TurnEnded, TurnStarted } from "@lemma/agent";
import { LlmRequestHook } from "@lemma/llm";

/**
 * A token budget for each turn, and a meter. A turn that has used `maxTokens` stops rather than ask the model again
 * (`AgentContinueHook`, after the agent's own decision); when a turn ends, a notice says how long it took, how often it
 * asked the model and for how long, how much text the model wrote, and the tokens it used. It observes the agent's
 * events (`TurnStarted`, `TurnEnded`) and wraps every model call (`LlmRequestHook`), which hands it the stream to
 * time and count.
 *
 * A folder plugin, written the way a user writes one: copy or link the folder into `~/.lemma/plugins/`. It imports only
 * packages the host supplies, and is written with promises (`@lemma/core/plain`).
 */

const Config = Schema.Struct({
  maxTokens: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 0))).annotate({
    title: "Tokens a turn may use",
    description: "A turn that has used this many stops before it asks the model again; 0 is no limit.",
  }),
});

/** A turn's meter, kept while it runs. */
export interface Meter {
  /** Undefined until its `TurnStarted` is observed: a model call can come first, as observers run on their own. */
  turnId: string | undefined;
  readonly startedAt: number;
  calls: number;
  modelMs: number;
  chars: number;
  tokens: number;
  stopped: boolean;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** What the notice says of a turn that ended. */
export const summary = (meter: Meter, endedAt: number, totalTokens: number, reason: string): string =>
  [
    `Turn ${meter.stopped ? "stopped at its token budget" : reason} after ${seconds(endedAt - meter.startedAt)}:`,
    `${plural(meter.calls, "model call")} taking ${seconds(meter.modelMs)},`,
    `${plural(meter.chars, "character")} written, ${plural(totalTokens, "token")}.`,
  ].join(" ");

export default definePlugin({
  id: "budget",
  version: "0.1.0",
  uses: ["lemma/agent@1", "lemma/llm@1"],
  config: Config,
  setup: (_deps, { config, observe, on, publish }) => {
    /** By session: a session runs one turn at a time. */
    const meters = new Map<string, Meter>();
    const meterOf = (sessionId: string, turnId?: string): Meter => {
      const found = meters.get(sessionId);
      if (found !== undefined && (found.turnId === undefined || turnId === undefined || found.turnId === turnId)) {
        found.turnId ??= turnId;
        return found;
      }
      const fresh: Meter = { turnId, startedAt: Date.now(), calls: 0, modelMs: 0, chars: 0, tokens: 0, stopped: false };
      meters.set(sessionId, fresh);
      return fresh;
    };

    observe(TurnStarted, ({ sessionId, turnId }) => void meterOf(sessionId, turnId));

    // Every model call, the agent's and any other plugin's that names a session; it times the stream to its end.
    on(LlmRequestHook, async (request, next) => {
      const stream = await next(request);
      if (request.sessionId === undefined) return stream;
      const meter = meterOf(request.sessionId);
      const started = Date.now();
      meter.calls++;
      return stream.pipe(
        Stream.tap((event) => Effect.sync(() => void (event.type === "text-delta" && (meter.chars += event.delta.length)))),
        Stream.ensuring(Effect.sync(() => void (meter.modelMs += Date.now() - started))),
      );
    });

    // After the agent's decision: a turn going on stops once it has used its budget.
    on(AgentContinueHook, async (outcome, next) => {
      const meter = meterOf(outcome.sessionId, outcome.turnId);
      meter.tokens += outcome.message.usage.totalTokens;
      const decision = await next(outcome);
      if (decision !== "continue" || config.maxTokens <= 0 || meter.tokens < config.maxTokens) return decision;
      meter.stopped = true;
      return "stop";
    });

    observe(TurnEnded, ({ sessionId, turnId, usage, reason }) => {
      const meter = meters.get(sessionId);
      if (meter === undefined || (meter.turnId !== undefined && meter.turnId !== turnId)) return;
      meters.delete(sessionId);
      publish(Notice, { level: "info", source: "budget", message: summary(meter, Date.now(), usage.totalTokens, reason) });
    });
  },
});
