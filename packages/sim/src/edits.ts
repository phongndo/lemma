import { Effect } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { AgentRequestHook } from "@lemma/agent";
import { toShorten } from "@lemma/context-prune";
import { deriveMessages } from "@lemma/sessions";
import type { Prng } from "./random.ts";

/**
 * A plugin changing what the model sees of earlier tool results as requests go out, as one shortening old tool output
 * does (`context.prune`, in place of a summary): before a request, by chance, each result the model has answered and
 * no edit has changed is put in a word (`context-edit`), and the request after declares its prompt afresh.
 */
export const simEdits = (prng: Prng) =>
  definePlugin({
    id: "sim.edits",
    setup: function* () {
      const owner = yield* PluginContext;
      yield* owner.on(AgentRequestHook, (draft, next) =>
        Effect.gen(function* () {
          if (!prng.chance(0.3)) return yield* next(draft);
          const appended = yield* Effect.forEach(toShorten(draft.branch, { minChars: 0, keepRecent: 0, exclude: [] }), (target) =>
            draft.append({
              type: "context-edit",
              target: target.id,
              op: "replace",
              content: [{ type: "text", text: "(shortened)" }],
              source: owner.id,
              turnId: draft.turnId,
            }),
          );
          const branch = [...draft.branch, ...appended];
          return yield* next({ ...draft, branch, history: deriveMessages(branch) });
        }),
      );
    },
  });
