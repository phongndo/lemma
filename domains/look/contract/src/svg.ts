/*
 * An SVG file of a person's own as an image (an MCP server's icon, a custom provider's logo): checked, and drawn from
 * a `data:` URL in an `<img>`, never inline, so scripts and handlers in it do not run and its ids cannot clash with the
 * page's. `SvgDrop` (picture.tsx) takes one picked or dropped.
 */

/** The largest SVG file taken: it is written into a config file. */
export const MAX_SVG_BYTES = 32 * 1024;

/** An SVG file's text without what draws nothing: its XML declaration, doctype, comments, and the space between tags. */
const bareSvg = (svg: string) =>
  svg
    .replace(/^﻿/, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();

/** What is wrong with an SVG file's text as an image of a person's own, if anything. */
export const svgProblem = (svg: string): string | undefined => {
  if (new TextEncoder().encode(svg).length > MAX_SVG_BYTES) return `That SVG file is over ${MAX_SVG_BYTES / 1024} KB`;
  const body = bareSvg(svg);
  return /^<svg[\s>]/i.test(body) && /<\/svg>$/i.test(body) ? undefined : "That is not an SVG file";
};

/** An SVG file's text as an image's address: a base64 `data:` URL of what draws in it. */
export const svgSource = (svg: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(bareSvg(svg))) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

/** An SVG file's text, without what draws nothing, or why it is not one to take. */
export type SvgFile = { readonly svg: string } | { readonly problem: string };

/** A file the person picked or dropped, read as an SVG file. */
export const readSvg = async (file: File): Promise<SvgFile> => {
  if (file.type !== "image/svg+xml" && !/\.svg$/i.test(file.name)) return { problem: "Choose an SVG file" };
  const text = await file.text();
  const problem = svgProblem(text);
  return problem === undefined ? { svg: bareSvg(text) } : { problem };
};

/** Asks for an SVG file with the browser's file picker: the one picked, read, or nothing when none is. */
export const pickSvg = (): Promise<SvgFile | undefined> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file === undefined ? undefined : readSvg(file));
    };
    input.oncancel = () => resolve(undefined);
    input.click();
  });
