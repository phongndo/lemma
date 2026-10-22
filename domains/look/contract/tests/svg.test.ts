import { describe, expect, it } from "vitest";
import { MAX_SVG_BYTES, readSvg, svgProblem, svgSource } from "../src/svg.ts";

const file = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Exported -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <title>Café</title>
  <circle cx="12" cy="12" r="10" fill="#10a37f"/>
</svg>
`;
// Read: its declaration and comment dropped, the space between its tags kept, as text can show it.
const drawn = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <title>Café</title>
  <circle cx="12" cy="12" r="10" fill="#10a37f"/>
</svg>`;
const PREFIX = "data:image/svg+xml;base64,";

describe("an SVG file of a person's own", () => {
  it("is drawn from a base64 data: URL of it as read", async () => {
    expect(svgProblem(file)).toBeUndefined();
    const read = await readSvg(new File([file], "logo.svg", { type: "image/svg+xml" }));
    const source = svgSource("svg" in read ? read.svg : "");
    expect(source.startsWith(PREFIX)).toBe(true);
    expect(Buffer.from(source.slice(PREFIX.length), "base64").toString("utf8")).toBe(drawn);
    // The largest it takes is a third larger written: base64, not percent-encoding, which can triple it.
    const largest = `<svg>${"<g/>".repeat(Math.floor((MAX_SVG_BYTES - 11) / 4))}</svg>`;
    expect(svgProblem(largest)).toBeUndefined();
    expect(svgSource(largest).length).toBeLessThan(MAX_SVG_BYTES * 1.34 + 32);
  });

  it("keeps the space text is drawn with, and takes a doctype with declarations of its own, as Illustrator writes", async () => {
    const words = '<svg xmlns="http://www.w3.org/2000/svg"><text><tspan>Acme</tspan> <tspan>AI</tspan></text></svg>';
    expect(await readSvg(new File([words], "logo.svg"))).toEqual({ svg: words });
    const illustrator = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
]>
<svg xmlns="&ns_svg;"><rect width="1" height="1"/></svg>`;
    expect(svgProblem(illustrator)).toBeUndefined();
  });

  it("is refused when it is not one, or too large to write into a config file", async () => {
    expect(svgProblem("<html><body/></html>")).toBe("That is not an SVG file");
    expect(svgProblem(`<svg>${" ".repeat(MAX_SVG_BYTES)}</svg>`)).toBe("That SVG file is over 32 KB");
    expect(await readSvg(new File([drawn], "logo.png", { type: "image/png" }))).toEqual({ problem: "Choose an SVG file" });
    expect(await readSvg(new File(["<html/>"], "logo.svg"))).toEqual({ problem: "That is not an SVG file" });
    expect(await readSvg(new File([file], "logo.svg", { type: "image/svg+xml" }))).toEqual({ svg: drawn });
  });
});
