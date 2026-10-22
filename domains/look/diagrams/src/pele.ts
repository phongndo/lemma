import { renderAsync } from "pele/lazy";

/*
 * Mermaid diagrams drawn by Pele as images, imported on first use (the
 * `diagrams` plugin loads this module lazily, and Pele each kind of diagram
 * the first time one is drawn). A diagram is model output, so it is shown as
 * an SVG `<img>`: an image cannot run script, load anything, or apply its
 * styles to the page, whatever the source says.
 */

const CACHE_MAX = 100;

/** How a diagram is drawn, as plain values (an image cannot read the page's tokens). */
export interface DiagramLook {
  readonly font: string;
  readonly colors: DiagramColors;
}
export interface DiagramColors {
  /** Behind the diagram and its edge labels. */
  readonly background: string;
  readonly node: string;
  /** Around nodes and groups. */
  readonly border: string;
  readonly text: string;
  /** Group titles, axes, and other secondary text. */
  readonly muted: string;
  /** Edges and arrowheads. */
  readonly line: string;
  /** Notes, and inside groups (subgraphs). */
  readonly note: string;
  /** What a diagram highlights. */
  readonly accent: string;
}

/** The Pele theme variable each color sets. */
const VARIABLES: Record<keyof DiagramColors, string> = {
  background: "--pele-bg",
  node: "--pele-surface",
  border: "--pele-border",
  text: "--pele-fg",
  muted: "--pele-muted",
  line: "--pele-line",
  note: "--pele-surface-alt",
  accent: "--pele-accent",
};

/** Rendered diagrams by look and source, so re-rendering a message (a draft settling) is instant. */
const cache = new Map<string, Promise<string>>();

const draw = async (code: string, look: DiagramLook): Promise<string> => {
  const started = performance.now();
  // No images: they would load from wherever the source says.
  const { svg, width, height } = await renderAsync(code, { fontFamily: look.font, images: false });
  const colors = Object.entries(VARIABLES)
    .map(([color, variable]) => `${variable}:${look.colors[color as keyof DiagramColors]}`)
    .join(";");
  // Pele's diagram reads its colors from the element around it: in an image, an `<svg>` of the same size.
  const framed = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="${colors}">${svg}</svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(framed)}`;
  // Shows in DevTools' performance panel, and to `performance.getEntriesByName("lemma:diagram")`.
  performance.measure("lemma:diagram", { start: started, detail: { chars: code.length } });
  return url;
};

/** `code` drawn as an SVG data URL in `look`; rejects with Pele's message when the source is invalid. */
export const renderDiagram = (code: string, look: DiagramLook): Promise<string> => {
  const key = `${JSON.stringify(look)}\u0000${code}`;
  let result = cache.get(key);
  if (result === undefined) {
    result = draw(code, look);
    cache.set(key, result);
    result.catch(() => cache.delete(key));
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return result;
};
