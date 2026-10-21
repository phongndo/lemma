import { Effect } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { AgentRequestHook } from "@lemma/agent";
import { deriveMessages, modelEntries } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import type { Prng } from "./random.ts";

/**
 * The tool results on `branch` the model has answered (a response follows them in its view) that no `context-edit` has
 * changed yet.
 */
const answeredResults = (branch: readonly SessionEvent[]): readonly SessionEvent[] => {
  const edited = new Set(branch.flatMap((event) => (event.data.type === "context-edit" ? [event.data.target] : [])));
  const entries = modelEntries(branch);
  // Where the latest response is: the results before it are answered.
  let answered = 0;
  for (const [at, entry] of entries.entries()) if (entry.message.role === "assistant") answered = at;
  return entries.slice(0, answered).flatMap((entry) => {
    const event = branch[entry.index]!;
    return entry.summary !== true && entry.message.role === "toolResult" && !edited.has(event.id) ? [event] : [];
  });
};

/**
 * A plugin changing what the model sees of earlier tool results as requests go out, as a plugin shortening old tool
 * output would: before a request, by chance, each result the model has answered and no edit has changed is put in a
 * word (`context-edit`), and the request after declares its prompt afresh.
 */
export const simEdits = (prng: Prng) =>
  definePlugin({
    id: "sim.edits",
    setup: function* () {
      const owner = yield* PluginContext;
      yield* owner.on(AgentRequestHook, (draft, next) =>
        Effect.gen(function* () {
          if (!prng.chance(0.3)) return yield* next(draft);
          const appended = yield* Effect.forEach(answeredResults(draft.branch), (target) =>
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
