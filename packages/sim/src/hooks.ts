import { Duration, Effect } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { AgentError, AgentInputHook, AgentRequestHook } from "@lemma/agent";
import type { Prng } from "./random.ts";

/**
 * How a plugin around the agent's operations misbehaves, each a chance per operation, drawn once per run: one that
 * takes its time, or fails, holds the operation up or fails it, as a slow or broken user plugin would.
 */
export interface HookFaults {
  /** Around a new prompt: takes up to seconds. */
  readonly inputSlow: number;
  /** Around a new prompt: fails it. */
  readonly inputFail: number;
  /** Around a new prompt: answers it itself, or refuses it. */
  readonly inputAnswer: number;
  /** Around a request: takes up to seconds. */
  readonly requestSlow: number;
  /** Around a request: fails it, and so the turn. */
  readonly requestFail: number;
}

export const NO_HOOK_FAULTS: HookFaults = { inputSlow: 0, inputFail: 0, inputAnswer: 0, requestSlow: 0, requestFail: 0 };

/** A plugin handling `AgentInputHook` and `AgentRequestHook` as `faults` draws, passing each on otherwise. */
export const simHooks = (prng: Prng, faults: HookFaults) =>
  definePlugin({
    id: "sim.hooks",
    setup: function* () {
      const owner = yield* PluginContext;
      const pause = (chance: number) => (prng.chance(chance) ? Effect.sleep(Duration.millis(prng.between(100, 10_000))) : Effect.void);
      yield* owner.on(AgentInputHook, (input, next) =>
        Effect.gen(function* () {
          yield* pause(faults.inputSlow);
          if (prng.chance(faults.inputFail)) {
            return yield* new AgentError({ sessionId: input.sessionId, reason: "Hook", message: "sim.hooks failed the prompt" });
          }
          if (prng.chance(faults.inputAnswer)) {
            return prng.chance(0.5)
              ? ({ kind: "handle", message: "Handled by sim.hooks" } as const)
              : ({ kind: "refuse", reason: "Refused by sim.hooks" } as const);
          }
          return yield* next(input);
        }),
      );
      yield* owner.on(AgentRequestHook, (draft, next) =>
        Effect.gen(function* () {
          yield* pause(faults.requestSlow);
          if (prng.chance(faults.requestFail)) {
            return yield* new AgentError({ sessionId: draft.sessionId, reason: "Hook", message: "sim.hooks failed the request" });
          }
          return yield* next(draft);
        }),
      );
    },
  });
