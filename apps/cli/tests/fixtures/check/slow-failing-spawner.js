import { spawn } from "node:child_process";
import { definePlugin } from "@lemma/core/plain";

// A plugin that starts a child process, takes its time, then fails to start, so `check.test.ts` can end the check
// before the host fails to start.
export default definePlugin({
  id: "slow-failing-spawner",
  setup: async () => {
    spawn("sleep", ["4332"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    throw new Error("cannot start: its helper never answered");
  },
});
