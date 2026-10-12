import { spawn } from "node:child_process";
import { definePlugin } from "@lemma/core/plain";

// A plugin that starts a child process and leaves it running, as `check.test.ts` expects the report to say, and the
// check to stop.
export default definePlugin({
  id: "spawner",
  setup: () => {
    spawn("sleep", ["4329"], { stdio: "ignore" });
  },
});
