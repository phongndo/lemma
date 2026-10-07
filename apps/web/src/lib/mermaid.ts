import mermaid from "mermaid";

/*
 * Mermaid diagrams as images, imported on first use (the `diagrams` plugin
 * loads this module lazily). A diagram is model output, so it is shown as an
 * SVG `<img>`: an image cannot run script, load anything, or apply its styles
 * to the page, whatever the source says.
 */

const CACHE_MAX = 100;

/** How a diagram is drawn, as plain values (an image cannot read the page's tokens). */
export interface DiagramLook {
  readonly dark: boolean;
  readonly font: string;
  /** Colors of the page's to draw in; none draws in Mermaid's own light or dark theme. */
  readonly colors?: DiagramColors | undefined;
}
export interface DiagramColors {
  /** Behind the diagram, inside its nodes, and their borders. */
  readonly background: string;
  readonly node: string;
  readonly border: string;
  readonly text: string;
  readonly line: string;
  /** Notes. */
  readonly note: string;
}

/** Rendered diagrams by look and source, so re-rendering a message (a draft settling) is instant. */
const cache = new Map<string, Promise<string>>();
/** Mermaid keeps global state while it renders; one at a time. */
let queue: Promise<unknown> = Promise.resolve();
let drawnLook: string | undefined;
let count = 0;

/** The SVG with its drawn size as width and height, which an `<img>` needs (Mermaid sizes it by CSS instead). */
const sized = (svg: string): string => {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const box = root
    .getAttribute("viewBox")
    ?.split(/[\s,]+/)
    .map(Number);
  if (box !== undefined && box.length === 4 && box.every(Number.isFinite)) {
    root.setAttribute("width", String(Math.ceil(box[2]!)));
    root.setAttribute("height", String(Math.ceil(box[3]!)));
    root.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(root);
};

/** Mermaid's theme variables for drawing in `colors`, with its `base` theme, the one that takes colors. */
const themeVariables = (dark: boolean, font: string, colors: DiagramColors) => ({
  darkMode: dark,
  fontFamily: font,
  background: colors.background,
  mainBkg: colors.node,
  primaryColor: colors.node,
  secondaryColor: colors.node,
  tertiaryColor: colors.background,
  primaryTextColor: colors.text,
  secondaryTextColor: colors.text,
  tertiaryTextColor: colors.text,
  textColor: colors.text,
  titleColor: colors.text,
  nodeTextColor: colors.text,
  primaryBorderColor: colors.border,
  secondaryBorderColor: colors.border,
  tertiaryBorderColor: colors.border,
  nodeBorder: colors.border,
  clusterBkg: colors.background,
  clusterBorder: colors.border,
  lineColor: colors.line,
  edgeLabelBackground: colors.background,
  noteBkgColor: colors.note,
  noteTextColor: colors.text,
  noteBorderColor: colors.border,
  actorBkg: colors.node,
  actorBorder: colors.border,
  actorTextColor: colors.text,
  signalColor: colors.line,
  signalTextColor: colors.text,
});

const draw = async (code: string, look: DiagramLook, key: string): Promise<string> => {
  if (drawnLook !== key) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      fontFamily: look.font,
      ...(look.colors === undefined
        ? { theme: look.dark ? "dark" : "default" }
        : { theme: "base", themeVariables: themeVariables(look.dark, look.font, look.colors) }),
    });
    drawnLook = key;
  }
  const started = performance.now();
  const { svg } = await mermaid.render(`lemma-mermaid-${++count}`, code);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized(svg))}`;
  // Shows in DevTools' performance panel, and to `performance.getEntriesByName("lemma:mermaid")`.
  performance.measure("lemma:mermaid", { start: started, detail: { chars: code.length } });
  return url;
};

/** `code` drawn as an SVG data URL in `look`; rejects with Mermaid's message when the source is invalid. */
export const renderDiagram = (code: string, look: DiagramLook): Promise<string> => {
  const lookKey = JSON.stringify(look);
  const key = `${lookKey}\u0000${code}`;
  let result = cache.get(key);
  if (result === undefined) {
    result = queue.then(() => draw(code, look, lookKey));
    queue = result.catch(() => {});
    cache.set(key, result);
    result.catch(() => cache.delete(key));
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return result;
};
