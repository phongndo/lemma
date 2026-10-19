import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineLocalImages } from "../src/files.ts";
import { HTML_MEASURE_SOURCE, htmlBootstrap, htmlTheme, htmlThemeCss, withHtmlBootstrap } from "../src/html.ts";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("a page's bootstrap", () => {
  it("goes first in its head, else in a head of its own, and gives a page without a doctype one", () => {
    expect(withHtmlBootstrap("<!DOCTYPE html><html><head><title>t</title></head></html>", "<b>")).toBe(
      "<!DOCTYPE html><html><head><b><title>t</title></head></html>",
    );
    expect(withHtmlBootstrap("<html lang=en><body>x</body></html>", "<b>")).toBe("<!doctype html><html lang=en><head><b></head><body>x</body></html>");
    expect(withHtmlBootstrap("<p>x</p>", "<b>")).toBe("<!doctype html><b><p>x</p>");
  });

  it("sets every theme variable, the app's own value where it has one", () => {
    const css = htmlThemeCss({ "--bg": "#123456", "--chart-1": "" }, "light");
    expect(css).toContain("color-scheme: light;");
    expect(css).toContain("--bg: #123456;");
    expect(css).toContain(`--chart-1: ${htmlTheme("light")["--chart-1"]};`);
    expect(htmlBootstrap(css)).toContain(`<style id="lemma-theme">${css}</style>`);
  });

  it("reports the height HTML_MEASURE_SOURCE measures, and leaves scrollbars showing", () => {
    expect(htmlBootstrap("")).toContain(HTML_MEASURE_SOURCE);
    expect(htmlBootstrap("")).not.toContain("scrollbar");
  });
});

describe("inlining a page's local images", () => {
  it("inlines images by their bytes, in attributes, CSS, and scripts, and names what it left", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-html-"));
    try {
      const png = join(dir, "shot.png");
      const disguised = join(dir, "secret.png");
      await writeFile(png, Buffer.from(PIXEL, "base64"));
      await writeFile(disguised, "not an image");
      const html = `<img src="${png}"><div style="background: url(${png})"></div><script>const s = "${png}";</script><img src='${disguised}'><img src="${join(dir, "gone.webp")}">`;
      const { html: inlined, missing } = await inlineLocalImages(html);
      expect(inlined.match(new RegExp(`data:image/png;base64,${PIXEL.replace(/[+/=]/g, "\\$&")}`, "g"))).toHaveLength(3);
      expect(inlined).toContain(`src='${disguised}'`);
      expect([...missing].sort()).toEqual([disguised, join(dir, "gone.webp")].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("inlines a quoted path with spaces, and each candidate of a srcset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemma-html-"));
    try {
      const spaced = join(dir, "My Shot.png");
      const small = join(dir, "a.png");
      await writeFile(spaced, Buffer.from(PIXEL, "base64"));
      await writeFile(small, Buffer.from(PIXEL, "base64"));
      const html = `<img src="${spaced}"><img srcset="${small} 1x, ${join(dir, "gone.png")} 2x" src='${small}'>`;
      const { html: inlined, missing } = await inlineLocalImages(html);
      const url = `data:image/png;base64,${PIXEL}`;
      expect(inlined).toBe(`<img src="${url}"><img srcset="${url} 1x, ${join(dir, "gone.png")} 2x" src='${url}'>`);
      expect(missing).toEqual([join(dir, "gone.png")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a URL on another host that starts with //, which is no local path", async () => {
    const html = `<img src="//cdn.example.com/logo.png"><div style="background: url(//cdn.example.com/bg.webp)"></div><img srcset="//cdn.example.com/a.png 1x">`;
    expect(await inlineLocalImages(html)).toEqual({ html, missing: [] });
  });
});
