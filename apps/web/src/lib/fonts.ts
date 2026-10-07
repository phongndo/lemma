/*
 * Whether a font can show. A browser does not list the fonts installed, so
 * this measures: text in a missing font falls back to the generic family
 * after it and measures the same as that family alone.
 */

const GENERIC = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "cursive", "fantasy"]);
const unquote = (name: string) => name.trim().replace(/^["']|["']$/g, "");
let canvas: CanvasRenderingContext2D | null | undefined;

/**
 * Whether the first font of a CSS font-family list shows: a generic family,
 * one installed, or one declared with `@font-face`. Measured each time, so a
 * font a plugin declares or drops since counts as it is now.
 */
export const fontAvailable = (family: string): boolean => {
  const name = unquote(family.split(",")[0] ?? "");
  if (name === "" || GENERIC.has(name)) return true;
  if ([...document.fonts].some((face) => unquote(face.family) === name)) return true;
  canvas ??= document.createElement("canvas").getContext("2d");
  if (canvas === null) return true;
  const context = canvas;
  const width = (font: string) => {
    context.font = `32px ${font}`;
    return context.measureText("mmmmmmmmmmlli10OQ@#").width;
  };
  return ["monospace", "serif", "sans-serif"].some((generic) => width(`"${name}", ${generic}`) !== width(generic));
};
