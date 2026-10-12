import { spawn } from "node:child_process";
import { definePlugin } from "@lemma/core/plain";

// A plugin that starts a child process and then fails to start, leaving the child running, as `check.test.ts` expects
// the report to say.
export default definePlugin({
  id: "failing-spawner",
  setup: () => {
    spawn("sleep", ["4333"], { stdio: "ignore" });
    throw new Error("cannot start: its helper never answered");
  },
});
