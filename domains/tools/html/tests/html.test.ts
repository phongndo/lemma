import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HTML_MAX_CHARS } from "@lemma/tools/html";
import { attempt, call, context, tempDir, textOf } from "@lemma/tools/testing";
import { htmlRenderTool, HtmlRenderInput, MAX_PAGE_BYTES } from "../src/index.ts";
import type { HtmlRenderDetails } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

describe("html_render", () => {
  it("shows a page in the chat: logged whole in its details, and a script reads that it was shown", async () => {
    const result = await call(htmlRenderTool, { title: "Chart", html: "<p>hi</p>", height: 300 }, context(dir));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Shown to the person as "Chart"');
    expect(result.details).toEqual({ title: "Chart", html: "<p>hi</p>", height: 300 } satisfies HtmlRenderDetails);
    expect(result.structured).toEqual({ shown: true, title: "Chart", missingImages: [] });
  });

  it("is a tool the model calls and the chat shows outside the fold", () => {
    expect(htmlRenderTool.display).toBe(true);
    expect(htmlRenderTool.nested).toBeUndefined();
    expect(htmlRenderTool.output).toBeDefined();
  });

  it("inlines local images, and names those it could not", async () => {
    const image = path.join(dir, "shot.png");
    await fs.writeFile(image, PNG);
    const secret = path.join(dir, "secret.png");
    await fs.writeFile(secret, "not an image");
    const missing = path.join(dir, "gone.webp");
    const html = `<img src="${image}"><div style="background: url(${secret})"></div><script>const src = '${missing}';</script>`;
    const result = await call(htmlRenderTool, { title: "Shots", html }, context(dir));
    const details = result.details as HtmlRenderDetails;
    expect(details.html).toContain(`<img src="data:image/png;base64,${PNG.toString("base64")}">`);
    // A file that is not an image stays a path: its contents never reach the page.
    expect(details.html).toContain(`url(${secret})`);
    expect(details.html).toContain(`'${missing}'`);
    expect(details.missingImages).toEqual([secret, missing]);
    expect(result.structured).toEqual({ shown: true, title: "Shots", missingImages: [secret, missing] });
    expect(textOf(result)).toContain(`were not inlined (missing, not an image, or too large), so the page shows them broken: ${secret}, ${missing}`);
  });

  it("refuses a page that grows past what the log keeps once its images are inlined", async () => {
    const image = path.join(dir, "big.png");
    // Base64 makes it a third larger: over the cap once inlined, under the inliner's own per-image limit.
    await fs.writeFile(image, Buffer.concat([PNG, Buffer.alloc(Math.ceil(MAX_PAGE_BYTES * 0.8))]));
    expect(await attempt(htmlRenderTool, { title: "Big", html: `<img src="${image}">` }, context(dir))).toMatch(
      /^error: The page is \d+\.\d MiB with its images inlined, over the 5\.0 MiB a page may be/,
    );
  });

  it("takes a title, a page within the limit, and a height cap in range", () => {
    const decode = Schema.decodeUnknownSync(HtmlRenderInput);
    for (const input of [
      { title: "", html: "<p></p>" },
      { title: "x".repeat(201), html: "<p></p>" },
      { title: "T", html: "" },
      { title: "T", html: "x".repeat(HTML_MAX_CHARS + 1) },
      { title: "T", html: "<p></p>", height: 79 },
      { title: "T", html: "<p></p>", height: 2001 },
      { title: "T", html: "<p></p>", height: 120.5 },
    ]) {
      expect(() => decode(input)).toThrow();
    }
    expect(decode({ title: "T", html: "<p></p>", height: 2000 })).toEqual({ title: "T", html: "<p></p>", height: 2000 });
  });
});
