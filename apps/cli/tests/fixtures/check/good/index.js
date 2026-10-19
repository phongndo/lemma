import { AgentRequestHook } from "@lemma/agent";
import { definePlugin } from "@lemma/core/plain";

// A plugin that works: it handles a hook, as `check.test.ts` expects the report to say.
export default definePlugin({
  id: "good",
  uses: ["lemma/agent@1"],
  setup: (_, { on }) => on(AgentRequestHook, (draft, next) => next(draft)),
});
