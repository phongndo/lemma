import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { DEFAULT_BASH_TIMEOUT, makeBashTool } from "./bash.ts";

export { bashTool, BashInput, BashOutput, DEFAULT_BASH_TIMEOUT, makeBashTool } from "./bash.ts";
export type { BashDetails } from "./bash.ts";

const BashConfig = Schema.Struct({
  timeout: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => DEFAULT_BASH_TIMEOUT)))
    .annotate({
      title: "Default timeout",
      description: "Seconds a command may run when the model names no timeout of its own. 0: no limit.",
    }),
});

/** The `bash` tool, with the default timeout its config sets. */
export default definePlugin({
  id: "tools.bash",
  version: "0.1.0",
  config: BashConfig,
  setup: function* (_, owner) {
    yield* owner.add(Tools, makeBashTool(owner.config.timeout));
  },
});
