import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Installs the packed router into an application outside this workspace and runs it there: the declarations type-check,
// a Node consumer passes, and with `--browser` a consumer bundled by esbuild passes in Chromium, its size recorded.
const router = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(router, "package.json"), "utf8"));
const consumer = mkdtempSync(join(tmpdir(), "router-package-check-"));
const run = (command: string, args: string[], cwd = consumer) => execFileSync(command, args, { cwd, stdio: "inherit" });

async function checkBrowser() {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const { finish, record } = await import("../bench/budgets.ts");
  const bundle = await build({ entryPoints: [join(consumer, "browser.ts")], bundle: true, format: "esm", platform: "browser", minify: true, write: false });
  const script = bundle.outputFiles[0]!.contents;
  const html = readFileSync(join(consumer, "browser.html"));
  // Every path is the page, as an app's server serves it at every route.
  const server = createServer((request, response) => {
    if (request.url === "/browser.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(script);
    } else {
      response.setHeader("content-type", "text/html");
      response.end(html);
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const executablePath = process.env.LEMMA_CHROMIUM;
  try {
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.body.dataset.status !== undefined, undefined, { timeout: 10_000 });
      assert.equal(await page.getAttribute("body", "data-status"), "passed", await page.locator("output").innerText());
      assert.deepEqual(errors, []);
      console.log(`Browser consumer: browser history, links, blockers, and back and forward passed (${browser.version()}).`);
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

try {
  // Pack invokes prepack, building exactly what a separate application receives.
  run("pnpm", ["pack", "--out", join(consumer, "router.tgz")], router);
  cpSync(join(router, "scripts/consumer"), consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "router-external-consumer",
        private: true,
        type: "module",
        dependencies: { "@lemma/router": "file:./router.tgz", effect: manifest.dependencies.effect },
        devDependencies: { typescript: manifest.devDependencies.typescript, "@types/node": manifest.devDependencies["@types/node"] },
      },
      null,
      2,
    ),
  );
  // This directory has no workspace links or source aliases.
  run("pnpm", ["install", "--ignore-workspace", "--ignore-scripts"]);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  run(process.execPath, ["dist/main.js"]);
  if (process.argv.includes("--browser")) await checkBrowser();
  console.log("Packed router: declarations, Node.js, and browser checks passed.");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
