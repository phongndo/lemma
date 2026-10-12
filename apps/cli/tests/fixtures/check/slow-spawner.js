import { spawn } from "node:child_process";
import { definePlugin } from "@lemma/core/plain";

// A plugin that starts a child process, then takes its time to start, so `check.test.ts` can end the check while the
// host is still starting.
export default definePlugin({
  id: "slow-spawner",
  setup: async () => {
    spawn("sleep", ["4331"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  },
});
