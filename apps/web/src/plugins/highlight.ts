import { CodeBlocks, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import styles from "./highlight.css?inline";

type Highlighter = typeof import("../lib/highlight.ts");

/**
 * Syntax highlighting for fenced code, through the `markdown.code` slot.
 * Shiki and each grammar load on first use. Code that is still streaming is
 * highlighted as it grows once its language has loaded, plain until then.
 */
export default defineUiPlugin({
  id: "highlight",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }) => {
    let loaded: Highlighter | undefined;
    let loading: Promise<Highlighter> | undefined;
    const load = () => (loading ??= import("../lib/highlight.ts").then((module) => (loaded = module)));
    slots.add(CodeBlocks, {
      id: "highlight",
      order: 100,
      match: (lang) => lang !== "",
      render: (block, target) => {
        const now = loaded?.highlight(block.code, block.lang, block.complete);
        if (now !== undefined) return void target.append(now);
        const language = load().then((module) => module.loadLanguage(block.lang));
        // Incomplete code is rendered again as it grows, and highlighted from the first update after its grammar loads.
        if (!block.complete) return void language.catch(() => {});
        return language.then((known) => {
          const element = known ? loaded!.highlight(block.code, block.lang, true) : undefined;
          if (element !== undefined) target.append(element);
        });
      },
    });
  },
});
