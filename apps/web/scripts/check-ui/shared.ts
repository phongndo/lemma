import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit } from "playwright";
import type { Page } from "playwright";
import { createLogger, createServer } from "vite";
import { HOST_COOKIE, hostsOf, laneNow, routerUrl } from "./hosts.ts";
import type { Host } from "./hosts.ts";

/*
 * What every lane of the UI check (check-ui.ts) shares: the options, the dev server, the browser, and the helpers that
 * open, boot, and drive its pages, each on a real host of its lane's (hosts.ts).
 */

const { values: options } = parseArgs({
  options: { shard: { type: "string", default: "1/1" }, retry: { type: "string", default: "0" }, lane: { type: "string", multiple: true } },
});
export const [shard, shards] = options.shard.split("/").map(Number) as [number, number];
assert(Number.isInteger(shard) && Number.isInteger(shards) && shard >= 1 && shard <= shards, `--shard is i/n, not "${options.shard}"`);
/** How many more times a lane that fails runs, as CI asks (`--retry=n`); none by default, so a flake shows at once. */
export const retries = Number(options.retry);
assert(Number.isInteger(retries) && retries >= 0, `--retry is a count, not "${options.retry}"`);
/** The lanes `--lane` names (it may be given more than once), else all of them. */
export const only: readonly string[] | undefined = options.lane;

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Its `/rpc` and `/api` go to the router, which sends each page's to its host (vite.config.ts reads `LEMMA_HOST_URL`).
process.env.LEMMA_HOST_URL = routerUrl;
delete process.env.LEMMA_HOST_TOKEN;
// A page closed, or its host stopped, at the end of its lane's try cuts its streams off midway: the proxy's word on that
// is no failure of the check's.
const logger = createLogger("error");
const logError = logger.error;
logger.error = (message, options) => {
  if (!/(?:ws|http) proxy (?:socket )?error/.test(message)) logError(message, options);
};
export const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  customLogger: logger,
  server: { port: 0, host: "127.0.0.1" },
});
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

/** Every page opened, traced, with its lane and host, so that a failure can leave its trace and a screenshot behind. */
const pages: { readonly page: Page; readonly lane: string | undefined; readonly host: Host }[] = [];
/** The host a page was opened on. */
export const hostOf = (page: Page): Host => pages.find((opened) => opened.page === page)!.host;
/** A page of its own (a new browser context) on `host`, which its cookie names to the router. */
export const open = async (host: Host) => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.context().addCookies([{ name: HOST_COOKIE, value: host.key, url }]);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  pages.push({ page, lane: laneNow(), host });
  return page;
};
/** Where a run's traces, screenshots, and host logs go: `LEMMA_UI_ARTIFACTS`, else a new directory under the OS temp directory. */
let artifacts: string | undefined;
const artifactsDir = () => {
  artifacts ??= process.env.LEMMA_UI_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "lemma-ui-check-"));
  mkdirSync(artifacts, { recursive: true });
  return artifacts;
};
/**
 * Leaves a trace and a screenshot of each page still open, and what each host printed, in the artifacts directory,
 * and says where. For a lane's failed try, those of its pages and hosts alone, named for it, whose pages then close:
 * the lane's next try opens its own.
 */
export const saveArtifacts = async (failed?: { readonly lane: string; readonly try: number }) => {
  const directory = artifactsDir();
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
  const lanes = failed === undefined ? [...new Set(pages.flatMap((opened) => (opened.lane === undefined ? [] : [opened.lane])))] : [failed.lane];
  for (const lane of lanes) {
    for (const [index, host] of hostsOf(lane).entries())
      writeFileSync(join(directory, `${failed === undefined ? `${lane}-` : prefix}host-${index + 1}.log`), host.output());
  }
  console.error(
    failed === undefined
      ? `UI check failed: traces, screenshots, and host logs are in ${directory}`
      : `UI check: ${failed.lane} failed on try ${failed.try}: its traces, screenshots, and host logs are in ${directory}`,
  );
};
/** Closes the pages `lane` opened: its try is over, and its hosts go. */
export const closePages = async (lane: string) => {
  for (const opened of pages) if (opened.lane === lane && !opened.page.isClosed()) await opened.page.context().close();
};
/** A page of its own on `host`, booted without errors. */
export const boot = async (host: Host) => {
  const { errors, warnings, expectNoErrors } = log();
  const page = await open(host);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto(`${url}/`);
  await settled(page);
  await page.waitForFunction(() => "lemma" in window && (window as any).lemma.plugins.list().length > 0);
  expectNoErrors("while booting");
  return { page, errors, warnings, expectNoErrors };
};
/**
 * Loads the `check` web half, a plugin like a user's, from a file in its host's plugin directory, and puts its own slots
 * on `window.checkSlots`: what the checks add, they add through it, since the page's own slots belong to no plugin and
 * refuse to add. Each item is the check plugin's, and leaves with it. The file stays, so a reload loads it again.
 */
export const checkPlugin = async (page: Page) => {
  await hostOf(page).plugins({
    "check.web.js": `export default ({ defineWebPlugin, contracts: { Slots } }) =>
      defineWebPlugin({ id: "check", requires: { slots: Slots }, setup: ({ slots }) => { window.checkSlots = slots; } });`,
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

/** Shows a view of the open thread by its id in its pane, as its palette command does, once the thread has loaded. */
export async function showView(page: Page, id: string): Promise<void> {
  // The pane is the open thread's, so a view is shown in it once the thread (a blank one too) has loaded.
  await page.waitForFunction(
    async () => {
      const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (await (window as any).lemma.service(Threads)).active() !== undefined;
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    async (view) => {
      const { Actions } = (await import("/src/ui/api.ts" as string)).api.contracts;
      const action = (window as any).lemma.slots().get(Actions, `thread.view.${view}`);
      action?.run();
      return action !== undefined;
    },
    id,
    { timeout: 10_000 },
  );
}
