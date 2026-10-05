import { Effect } from "effect";
import { AgentError, NATIVE_HARNESS } from "@lemma/contracts";
import type { Harness, HarnessTurn, ModelInfo, TurnOptions } from "@lemma/contracts";
import { LiveTurn } from "./live.ts";
import { planResume } from "./resume.ts";
import { readLive } from "./state.ts";
import { runTurn } from "./turn.ts";
import type { TurnResume, TurnServices, TurnSettings } from "./turn.ts";

export interface NativeOptions {
  readonly services: TurnServices;
  readonly settings: TurnSettings;
  /** `<provider>/<model>` for turns that name none; else the first available model. */
  readonly defaultModel?: string;
  /** Where the agent keeps its state: a resumed turn reads what its cut-off calls had produced there. */
  readonly home: string;
}

/**
 * The native harness: Lemma's own loop (`runTurn`), on the model a turn names,
 * with the tools and request handlers of the running plugins. It logs every
 * model request, and it continues a turn a restart cut off from where its log
 * stops.
 */
export function nativeHarness({ services, settings, defaultModel, home }: NativeOptions): Harness {
  const { sessions, llm } = services;

  const resolveModel = (sessionId: string, options?: TurnOptions): Effect.Effect<ModelInfo, AgentError> =>
    Effect.gen(function* () {
      const ref = options?.model ?? defaultModel;
      if (ref !== undefined) {
        return yield* llm.model(ref).pipe(Effect.mapError((error) => new AgentError({ sessionId, reason: "NoModel", message: error.message, cause: error })));
      }
      const [first] = yield* llm.models({ available: true });
      if (first === undefined) {
        return yield* new AgentError({
          sessionId,
          reason: "NoModel",
          message: "No model is available. Log in to a provider or configure agent.defaultModel.",
        });
      }
      return first;
    });

  /** The orchestrator hands over its own `LiveTurn`; a caller that hands over something else gets a private one. */
  const liveOf = (turn: HarnessTurn) => (turn.live instanceof LiveTurn ? turn.live : new LiveTurn(turn.turnId));

  const common = (turn: HarnessTurn) => ({
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    cwd: turn.cwd,
    signal: turn.signal,
    inbox: turn.inbox,
    live: liveOf(turn),
    logged: turn.logged,
    suspended: turn.suspended,
    ...(turn.title === undefined ? {} : { title: turn.title }),
  });

  const fresh = (turn: HarnessTurn) =>
    Effect.gen(function* () {
      const model = yield* resolveModel(turn.sessionId, turn.options);
      return yield* runTurn(services, settings, {
        ...common(turn),
        model,
        prompts: turn.prompts,
        ...(turn.options.thinking === undefined ? {} : { thinking: turn.options.thinking }),
      });
    });

  /** A turn a restart cut off, continued from where its log stops. */
  const resumed = (turn: HarnessTurn, cancelling: boolean) =>
    Effect.gen(function* () {
      const log = yield* sessions
        .events(turn.sessionId)
        .pipe(Effect.mapError((error) => new AgentError({ sessionId: turn.sessionId, reason: "Session", message: error.message, cause: error })));
      const resume = planResume(log, turn.turnId);
      if (resume.kind === "not-started") return cancelling ? ("cancelled" as const) : yield* fresh(turn);
      if (resume.kind === "ended") {
        const end = log.find((event) => event.data.type === "turn-end" && event.data.turnId === turn.turnId);
        return end?.data.type === "turn-end" ? end.data.reason : "done";
      }
      const { plan } = resume;
      // The model it ran on, if it still exists; else the default, as a new turn would get.
      const model =
        plan.model === undefined ? yield* resolveModel(turn.sessionId) : yield* llm.model(plan.model).pipe(Effect.orElse(() => resolveModel(turn.sessionId)));
      const restored = yield* readLive(home, turn.sessionId);
      const turnResume: TurnResume = {
        plan,
        cancelling,
        ...(restored?.turnId === turn.turnId ? { restored } : {}),
      };
      return yield* runTurn(services, settings, {
        ...common(turn),
        model,
        prompts: turn.prompts.filter((prompt) => !plan.placed.has(prompt.requestId)),
        resume: turnResume,
        ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
      });
    });

  return {
    id: NATIVE_HARNESS,
    title: "Lemma",
    description: "Lemma's own loop: the model you pick, the tools and plugins running here, and every model request in the log.",
    capabilities: { steer: true, models: true, resume: true, requests: true },
    status: Effect.succeed({ state: "ready" }),
    run: (turn) => (turn.resume === undefined ? fresh(turn) : resumed(turn, turn.resume.cancelling)),
  };
}
