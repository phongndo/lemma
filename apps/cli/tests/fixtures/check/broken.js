import { definePlugin } from "@lemma/core/plain";

// A plugin that fails to start, as `check.test.ts` expects the report to say.
export default definePlugin({
  id: "broken",
  setup: () => {
    throw new Error("cannot start: no settings");
  },
});
