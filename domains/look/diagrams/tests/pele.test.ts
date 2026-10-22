import { describe, expect, it } from "vitest";
import { renderDiagram } from "../src/pele.ts";
import type { DiagramLook } from "../src/pele.ts";

const look: DiagramLook = {
  font: "sans-serif",
  colors: { background: "#101010", node: "#202020", border: "#303030", text: "#f0f0f0", muted: "#a0a0a0", line: "#c0c0c0", note: "#404040", accent: "#3366cc" },
};
const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

describe("renderDiagram", () => {
  it("draws a diagram as a sized SVG image in the look's colors", async () => {
    const svg = svgOf(await renderDiagram("flowchart LR\n  A[Start] --> B[End]", look));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+(\.\d+)?" height="\d+(\.\d+)?"/);
    expect(svg).toContain("--pele-surface:#202020");
    expect(svg).toContain("--pele-line:#c0c0c0");
    expect(svg).toContain("Start");
  });
  it("draws no image a diagram names, which would load from wherever it says", async () => {
    const svg = svgOf(await renderDiagram('flowchart LR\n  A@{ img: "https://example.com/x.png", label: "pic", h: 60 } --> B', look));
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("example.com/x.png");
  });
  it("rejects invalid source with Pele's message", async () => {
    await expect(renderDiagram("flowchart TD\n  A -->", look)).rejects.toThrow(/Parse error/);
  });
});
