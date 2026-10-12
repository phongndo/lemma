import { execFileSync } from "node:child_process";
import { Hook } from "@lemma/core";
import { definePlugin } from "@lemma/core/plain";

/** A hook whose handler blocks the event loop for `ms`, as a plugin stuck in synchronous work does. */
export const Busy = Hook.make<number, number>("test/busy");
/** A hook whose handler blocks the event loop for `ms` outside JavaScript: in a synchronous child process. */
export const Waiting = Hook.make<number, number>("test/waiting");

export default definePlugin({
  id: "test.busy",
  setup: (_, { on }) => {
    on(Busy, (ms) => {
      const end = Date.now() + ms;
      let spun = 0;
      while (Date.now() < end) spun++;
      return spun;
    });
    on(Waiting, (ms) => {
      execFileSync("sleep", [String(ms / 1000)]);
      return ms;
    });
  },
});
