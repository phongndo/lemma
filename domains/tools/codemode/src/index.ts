import { definePlugin } from "@lemma/core";
import { ToolRunner, Tools } from "@lemma/tools";
import { codemodeTool } from "./codemode.ts";

export { codemodeTool, CodemodeInput } from "./codemode.ts";
export type { CodemodeDetails } from "./codemode.ts";

/** The `codemode` tool, whose scripts call the other tools through the `ToolRunner`. */
export default definePlugin({
  id: "tools.codemode",
  version: "0.1.0",
  requires: { runner: ToolRunner },
  setup: function* ({ runner }, owner) {
    yield* owner.add(Tools, codemodeTool(runner));
  },
});
