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
  /** Around a request: tells the model something first (a `context` event, appended on the turn's branch). */
  readonly requestContext: number;
  /**
   * Around a request: changes what it is made of, as a mode or a context plugin does: a section of its own whose text
   * changes, or one tool fewer, so the agent tells the change (`prompt-update`) or declares the prompt afresh (`restart`).
   */
  readonly requestShape: number;
}

export const NO_HOOK_FAULTS: HookFaults = {
  inputSlow: 0,
  inputFail: 0,
  inputAnswer: 0,
  requestSlow: 0,
  requestFail: 0,
  requestContext: 0,
  requestShape: 0,
};

/** The texts the section `requestShape` adds takes, one drawn per request it changes. */
const NOTES = ["Notes: keep going.", "Notes: prefer small steps.", "Notes: check the tests."];

/** A plugin handling `AgentInputHook` and `AgentRequestHook` as `faults` draws, passing each on otherwise. */
export const simHooks = (prng: Prng, faults: HookFaults, count: (what: string) => void = () => {}) =>
  definePlugin({
    id: "sim.hooks",
    setup: function* () {
      const owner = yield* PluginContext;
      const pause = (chance: number, what: string) => {
        if (!prng.chance(chance)) return Effect.void;
        count(what);
        return Effect.sleep(Duration.millis(prng.between(100, 10_000)));
      };
      yield* owner.on(AgentInputHook, (input, next) =>
        Effect.gen(function* () {
          yield* pause(faults.inputSlow, "hook inputSlow");
          if (prng.chance(faults.inputFail)) {
            count("hook inputFail");
            return yield* new AgentError({ sessionId: input.sessionId, reason: "Hook", message: "sim.hooks failed the prompt" });
          }
          if (prng.chance(faults.inputAnswer)) {
            count("hook inputAnswer");
            return prng.chance(0.5)
              ? ({ kind: "handle", message: "Handled by sim.hooks" } as const)
              : ({ kind: "refuse", reason: "Refused by sim.hooks" } as const);
          }
          return yield* next(input);
        }),
      );
      yield* owner.on(AgentRequestHook, (draft, next) =>
        Effect.gen(function* () {
          yield* pause(faults.requestSlow, "hook requestSlow");
          if (prng.chance(faults.requestFail)) {
            count("hook requestFail");
            return yield* new AgentError({ sessionId: draft.sessionId, reason: "Hook", message: "sim.hooks failed the request" });
          }
          if (prng.chance(faults.requestContext)) {
            count("hook requestContext");
            yield* draft.append({
              type: "context",
              source: "sim.hooks",
              content: [{ type: "text", text: `A reading: ${prng.between(0, 100)}` }],
              display: "a reading",
              turnId: draft.turnId,
            });
          }
          if (prng.chance(faults.requestShape)) {
            count("hook requestShape");
            const dropped = draft.tools.length > 0 && prng.chance(0.5) ? prng.pick(draft.tools).spec.name : undefined;
            return yield* next({
              ...draft,
              sections: [...draft.sections, { id: "sim.notes", source: owner.id, text: prng.pick(NOTES) }],
              tools: draft.tools.filter((tool) => tool.spec.name !== dropped),
            });
          }
          return yield* next(draft);
        }),
      );
    },
  });
