import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { codemodeTool } from "./codemode.ts";

export { codemodeTool, CodemodeInput } from "./codemode.ts";
export type { CodemodeDetails } from "./codemode.ts";

/** The `codemode` tool, built from the registry it registers with, whose tools its scripts call. */
export default definePlugin({
  id: "tools.codemode",
  version: "0.1.0",
  requires: { tools: Tools },
  setup: ({ tools }) => tools.register(codemodeTool(tools)),
});
