import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { chromium } from "playwright";
import { finish, record } from "../bench/budgets.ts";

/** Runs the packed consumer in a real browser. The caller owns the temporary install. */
export async function checkBrowser(consumer: string) {
  const bundle = await build({
    entryPoints: [join(consumer, "browser.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: true,
    write: false,
  });
  const script = bundle.outputFiles[0]!.contents;
  const html = readFileSync(join(consumer, "browser.html"));
  const server = createServer((request, response) => {
    switch (request.url) {
      case "/":
        response.setHeader("content-type", "text/html");
        response.end(html);
        break;
      case "/browser.js":
        response.setHeader("content-type", "text/javascript");
        response.end(script);
        break;
      default:
        response.statusCode = 204;
        response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const executablePath = process.env.LEMMA_CHROMIUM;
  try {
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}`);
      await page.waitForFunction(() => document.body.dataset.status !== undefined, undefined, { timeout: 10_000 });
      assert.equal(await page.getAttribute("body", "data-status"), "passed", await page.locator("output").innerText());
      assert.deepEqual(errors, []);
      console.log(`Browser consumer: DOM, hooks, events, replacement, failure isolation, and cleanup passed (${browser.version()}).`);
      record("browserBundleBytes", script.byteLength);
      record("browserBundleGzipBytes", gzipSync(script).byteLength);
      finish("browser");
    } finally {
      await browser.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
