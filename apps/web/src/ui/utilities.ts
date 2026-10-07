import { compile } from "tailwindcss";
import theme from "tailwindcss/theme.css?raw";
import utilities from "tailwindcss/utilities.css?raw";
import bundled from "virtual:lemma/utility-candidates";
import entry from "../tailwind.css?raw";

const sheets: Readonly<Record<string, string>> = { "tailwindcss/theme.css": theme, "tailwindcss/utilities.css": utilities };

/**
 * The Tailwind utilities for the app's own classes and `candidates` (UI
 * files'), compiled in the page from the same `tailwind.css` the build uses.
 * Linked after the app's styles, this one sheet decides the order of every
 * utility it holds, so a UI file's `px-4` beats the app's `p-2` as it would
 * in one build. Loaded only when a UI file has a script, keeping the compiler
 * out of the app's own bundle.
 */
export const compileUtilities = async (candidates: readonly string[]): Promise<string> => {
  // A fresh compiler each time: one keeps every class it has built, and a removed file's should go.
  const compiler = await compile(entry, {
    base: "/",
    loadStylesheet: async (id) => {
      const content = sheets[id];
      if (content === undefined) throw new Error(`tailwind.css imports ${id}, which the page does not have`);
      return { path: id, base: "/", content };
    },
  });
  return compiler.build([...bundled, ...candidates]);
};
