import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit } from "playwright";
import type { Page } from "playwright";
import { createServer } from "vite";

/*
 * What every lane of the UI check (check-ui.ts) shares: the options, the dev server with the in-browser mock host, the
 * browser, and the helpers that open, boot, and drive its pages.
 */

const { values: options } = parseArgs({ options: { shard: { type: "string", default: "1/1" }, retry: { type: "string", default: "0" } } });
export const [shard, shards] = options.shard.split("/").map(Number) as [number, number];
assert(Number.isInteger(shard) && Number.isInteger(shards) && shard >= 1 && shard <= shards, `--shard is i/n, not "${options.shard}"`);
/** How many more times a lane that fails runs, as CI asks (`--retry=n`); none by default, so a flake shows at once. */
export const retries = Number(options.retry);
assert(Number.isInteger(retries) && retries >= 0, `--retry is a count, not "${options.retry}"`);

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const address = server.httpServer?.address();
assert(address !== null && typeof address === "object", "the dev server has no address");
export const url = `http://127.0.0.1:${address.port}`;
// `LEMMA_BROWSER=firefox` or `webkit` runs it in Playwright's builds of those (`playwright install firefox webkit`).
const engine = { chromium, firefox, webkit }[process.env.LEMMA_BROWSER ?? "chromium"];
assert(engine !== undefined, `LEMMA_BROWSER is chromium, firefox, or webkit, not "${process.env.LEMMA_BROWSER}"`);
const executablePath = engine === chromium ? process.env.LEMMA_CHROMIUM : undefined;
// With the scrollbars a desktop draws (Playwright hides them), which take room from what they scroll.
export const browser = await engine.launch({
  headless: true,
  ...(engine === chromium ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}),
  ...(executablePath ? { executablePath } : {}),
});

/** What went wrong on a lane's pages (see `lanes` in check-ui.ts), kept apart from the other lanes'. */
export const log = () => {
  const errors: string[] = [];
  /** The app's warnings (`lemma web: …` problems, each also a toast). */
  const warnings: string[] = [];
  const expectNoErrors = (when: string) => {
    const found = errors.splice(0);
    assert.deepEqual(found, [], `errors ${when}`);
  };
  return { errors, warnings, expectNoErrors };
};
/** Resolves once the page has a frame drawn by whatever fills `root`. */
export const settled = (page: Page) => page.waitForFunction(() => document.querySelector("#root")!.childElementCount > 0, undefined, { timeout: 10_000 });
/** Resolves once the page has drawn two more frames: what changed before the call is laid out, and observers have run. */
export const drawn = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
/**
 * Puts the app's services on `window.services`, by contract name: a wait's page function runs synchronously, so it
 * reads them there rather than awaiting `lemma.service`. A reload drops them.
 */
export const expose = (page: Page, ...names: string[]) =>
  page.evaluate(async (names) => {
    const contracts = (await import("/src/ui/api.ts" as string)).api.contracts;
    const lemma = (window as any).lemma;
    (window as any).services = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await lemma.service(contracts[name])])));
  }, names);

/** Waits for the new-thread page (`/`) to have gone on to a blank thread, as it does once the app knows where one starts. */
export const atBlankThread = async (page: Page) => {
  await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (window as any).blankThreads = await (window as any).lemma.service(Threads);
  });
  await page.waitForFunction(() => {
    const threads = (window as any).blankThreads;
    return location.pathname.startsWith("/threads/") && threads.active() !== undefined && threads.blank();
  });
};

/** The lane running (check-ui.ts runs each in `inLane`), so that the pages of a lane's failed try can be set apart. */
const lane = new AsyncLocalStorage<string>();
export const inLane = <A>(name: string, run: () => Promise<A>): Promise<A> => lane.run(name, run);

/** Every page opened, traced, with its lane, so that a failure can leave its trace and a screenshot behind. */
const pages: { readonly page: Page; readonly lane: string | undefined }[] = [];
export const open = async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  pages.push({ page, lane: lane.getStore() });
  return page;
};
/**
 * Leaves a trace and a screenshot of each page still open in `LEMMA_UI_ARTIFACTS` (by default a new directory under
 * the OS temp directory), and says where. For a lane's failed try, those of its pages alone, named for it, which then
 * close: the lane's next try opens its own.
 */
export const saveArtifacts = async (failed?: { readonly lane: string; readonly try: number }) => {
  const directory = process.env.LEMMA_UI_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "lemma-ui-check-"));
  mkdirSync(directory, { recursive: true });
  const prefix = failed === undefined ? "" : `${failed.lane}-try-${failed.try}-`;
  for (const [index, opened] of pages.entries()) {
    if (opened.page.isClosed() || (failed !== undefined && opened.lane !== failed.lane)) continue;
    await opened.page.screenshot({ path: join(directory, `${prefix}page-${index + 1}.png`), fullPage: true }).catch(() => {});
    await opened.page
      .context()
      .tracing.stop({ path: join(directory, `${prefix}trace-${index + 1}.zip`) })
      .catch(() => {});
    if (failed !== undefined)
      await opened.page
        .context()
        .close()
        .catch(() => {});
  }
  console.error(
    failed === undefined
      ? `UI check failed: traces and screenshots are in ${directory}`
      : `UI check: ${failed.lane} failed on try ${failed.try}: its traces and screenshots are in ${directory}`,
  );
};
/** A page of its own, on a mock host of its own (a new page is a new browser context), booted without errors. */
export const boot = async () => {
  const { errors, warnings, expectNoErrors } = log();
  const page = await open();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.waitForFunction(() => "lemma" in window && (window as any).lemma.plugins.list().length > 0);
  expectNoErrors("while booting");
  return { page, errors, warnings, expectNoErrors };
};
/**
 * Loads the `check` web half, a plugin like a user's, and puts its own slots on `window.checkSlots`: what the checks
 * add, they add through it, since the page's own slots belong to no plugin and refuse to add. Each item is the check
 * plugin's, and leaves with it. A reload drops it, as it drops the mock host's files.
 */
export const checkPlugin = async (page: Page) => {
  await page.waitForFunction(() => "lemmaMock" in window && "lemma" in window);
  await page.evaluate(() => {
    const source = `export default ({ defineWebPlugin, contracts: { Slots } }) =>
      defineWebPlugin({ id: "check", requires: { slots: Slots }, setup: ({ slots }) => { window.checkSlots = slots; } });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    (window as any).lemmaMock.setWebFiles([{ name: "check.js", source: "user", kind: "script", path: "/check/check.js", url }]);
  });
  await page.waitForFunction(() => "checkSlots" in window, undefined, { timeout: 10_000 });
};
/** Turns a plugin on or off the way the Plugins page switches it, and says what state it is in after. */
export const switchTo = (page: Page, id: string, enabled: boolean) =>
  page.evaluate(
    async ({ id, enabled }) => {
      const lemma = (window as any).lemma;
      const plugin = lemma.plugins.list().find((candidate: any) => candidate.id === id);
      await lemma.plugins.setEnabled(plugin, enabled);
      return lemma.plugins.list().find((candidate: any) => candidate.id === id).state;
    },
    { id, enabled },
  );
