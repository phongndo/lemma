import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { htmlRenderTool } from "./html.ts";

export { htmlRenderTool, HtmlRenderInput, HtmlRenderOutput, MAX_HEIGHT, MAX_PAGE_BYTES, MIN_HEIGHT } from "./html.ts";
export type { HtmlRenderDetails } from "./html.ts";

/** The `html_render` tool: a page the model made, shown to the person in the chat. */
export default definePlugin({
  id: "tools.html",
  uses: ["lemma/tools@2"],
  version: "0.1.0",
  setup: function* (_, owner) {
    yield* owner.add(Tools, htmlRenderTool);
  },
});
