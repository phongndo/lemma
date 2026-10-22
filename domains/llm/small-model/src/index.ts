import { Effect } from "effect";
import { definePlugin } from "@lemma/core";
import { chooseSmallModel, Llm, LLM_CONTRACT, SmallModel } from "@lemma/llm";
import type { ModelRef } from "@lemma/llm";
import { Config } from "./config.ts";

/**
 * The model small tasks run on (`SmallModel`): the one its config names while it is available, else a small model of
 * the thread's provider, else the thread's own (`chooseSmallModel`), over the models available when it is asked.
 */
export default definePlugin({
  id: "llm.small-model",
  implements: [LLM_CONTRACT],
  version: "0.1.0",
  config: Config,
  requires: { llm: Llm },
  provides: { smallModel: SmallModel },
  setup: ({ llm }, owner) =>
    Effect.succeed({
      smallModel: {
        choose: (near?: ModelRef) => Effect.map(llm.models({ available: true }), (models) => chooseSmallModel(models, owner.config, near)),
      },
    }),
});
