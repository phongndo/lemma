import { definePlugin } from "@lemma/core/plain";

// A plugin that starts a timer it never clears, keeping its host from exiting, as `check.test.ts` expects the report to say.
export default definePlugin({
  id: "leaky",
  setup: () => {
    setInterval(() => {}, 1_000);
  },
});
