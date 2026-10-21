import { CodeBlocks, LOOK_PLUGINS } from "@lemma/look";
import { Slots, defineWebPlugin } from "@lemma/web";
import styles from "./highlight.css?inline";

type Highlighter = typeof import("./highlight.ts");

/** How long one slice of the highlighting held back for a grammar runs before the page gets a turn (ms). */
const SLICE_MS = 8;

/**
 * Syntax highlighting for fenced code, through the `markdown.code` slot.
 * Shiki and each grammar load on first use. Code that is still streaming is
 * highlighted as it grows once its language has loaded, plain until then.
 * The code that waited for a grammar is highlighted a slice at a time, the
 * last drawn first: a long thread opened draws hundreds of blocks at once,
 * and those at its end, in view, come first, while the page stays responsive.
 */
export default defineWebPlugin({
  id: LOOK_PLUGINS.highlight,
  styles,
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    let loaded: Highlighter | undefined;
    let loading: Promise<Highlighter> | undefined;
    const load = () => (loading ??= import("./highlight.ts").then((module) => (loaded = module)));
    /** What waits for its slice, the last drawn on top; each settles its block's promise. */
    const waiting: (() => void)[] = [];
    let slicing = false;
    const slice = () => {
      const until = performance.now() + SLICE_MS;
      while (waiting.length > 0 && performance.now() < until) waiting.pop()!();
      if (waiting.length > 0) plugin.after(0, slice);
      else slicing = false;
    };
    const later = (work: () => void) =>
      new Promise<void>((resolve, reject) => {
        waiting.push(() => {
          try {
            work();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        if (!slicing) {
          slicing = true;
          plugin.after(0, slice);
        }
      });
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
        return language.then((known) =>
          known
            ? later(() => {
                const element = loaded!.highlight(block.code, block.lang, true);
                if (element !== undefined) target.append(element);
              })
            : undefined,
        );
      },
    });
  },
});
