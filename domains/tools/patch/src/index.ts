import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { AgentRequestHook } from "@lemma/agent";
import { Tools } from "@lemma/tools";
import { patchTool } from "./patch.ts";

export { patchTool, PatchInput } from "./patch.ts";
export type { PatchDetails, PatchedFile } from "./patch.ts";

const Config = Schema.Struct({
  everyModel: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))).annotate({
    title: "Offer apply_patch to every model",
    description:
      "Offer apply_patch beside edit to every model. Off: OpenAI's GPT and Codex models, trained on apply_patch, get it instead of edit, and every other model gets edit.",
  }),
});

/**
 * Whether a model is of a family OpenAI trained on `apply_patch`: its GPT and Codex models (`openai/gpt-5.5`,
 * `openrouter/openai/gpt-oss-120b`, `openai/codex-mini-latest`), by its id, whoever serves it.
 */
export const trainedOnPatches = (model: string): boolean => /gpt|codex/i.test(model.slice(model.indexOf("/") + 1));

/**
 * The `apply_patch` tool, and one of it and `edit` offered to each request by its model: `apply_patch` to the models
 * trained on it, `edit` to the rest (`AgentRequestHook`'s `select` phase), unless `everyModel` offers both.
 */
export default definePlugin({
  id: "tools.patch",
  uses: ["lemma/agent@2", "lemma/tools@2"],
  version: "0.1.0",
  config: Config,
  setup: function* (_, owner) {
    yield* owner.add(Tools, patchTool);
    if (owner.config.everyModel) return;
    // On what the request offers once every other handler chose (a mode's own list among them): with only one of the
    // two on offer, that one stays whatever the model.
    yield* owner.on(
      AgentRequestHook,
      (draft, next) =>
        Effect.map(next(draft), (plan) => {
          const names = new Set(plan.tools.map((tool) => tool.spec.name));
          if (!names.has(patchTool.name) || !names.has("edit")) return plan;
          const left = trainedOnPatches(plan.model) ? "edit" : patchTool.name;
          return { ...plan, tools: plan.tools.filter((tool) => tool.spec.name !== left) };
        }),
      { phase: "select" },
    );
  },
});
