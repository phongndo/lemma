import { Effect } from "effect";
import { definePlugin } from "@lemma/core";
import { Browser } from "@lemma/browser";
import { ToolNamespaces, Tools } from "@lemma/tools";
import { browserNamespace, browserTools, htmlPreviewTool } from "./tools.ts";

export { browserNamespace, browserTools, htmlPreviewTool, HtmlPreviewInput, HtmlPreviewOutput } from "./tools.ts";

/**
 * The `browser_*` tools, which only scripts call (`nested`), in the `browser` namespace, and `html_preview`, which the
 * model calls too: all over whichever plugin provides `Browser`.
 */
export default definePlugin({
  id: "browser.tools",
  uses: ["lemma/browser@1", "lemma/llm@3", "lemma/tools@2"],
  version: "0.1.0",
  requires: { browser: Browser },
  setup: function* ({ browser }, owner) {
    yield* owner.add(ToolNamespaces, browserNamespace);
    yield* Effect.forEach([...browserTools(browser), htmlPreviewTool(browser)], (tool) => owner.add(Tools, tool), { discard: true });
  },
});
