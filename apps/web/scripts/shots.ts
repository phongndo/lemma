import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { createServer } from "vite";

/**
 * Screenshots of the app's main screens against the mock host, for comparing
 * a change's look before and after (`scripts/compare-shots.ts`). Writes PNGs
 * to the directory given as the first argument.
 *
 *   nix develop .#browser -c node scripts/shots.ts /tmp/lemma-shots/before
 */

const out = resolve(process.argv[2] ?? "shots");
mkdirSync(out, { recursive: true });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const address = server.httpServer?.address();
if (address === null || typeof address !== "object") throw new Error("the dev server has no address");
const executablePath = process.env.LEMMA_CHROMIUM;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

// Animations and the caret make pixels differ between identical renders.
const still = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
const shot = async (page: Page, name: string) => {
  await page.addStyleTag({ content: still });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
};

try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: theme });
    await page.goto(`http://127.0.0.1:${address.port}/?mock`);
    await page.waitForSelector("textarea");
    await shot(page, `${theme}-01-new-chat`);
    await page.fill("textarea", "Show me the packages");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".turn-footer", { timeout: 30_000 });
    await page.waitForSelector(".code-preview img", { timeout: 30_000 });
    await shot(page, `${theme}-02-answer`);
    await page.click(".work-head");
    await shot(page, `${theme}-03-work-open`);
    await page.click(".work-head");
    await page.keyboard.press("ControlOrMeta+k");
    await shot(page, `${theme}-04-palette`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    await page.waitForSelector(".settings");
    await shot(page, `${theme}-05-settings-general`);
    for (const [index, section] of ["Appearance", "Keyboard", "Providers", "Plugins", "Projects"].entries()) {
      await page.click(`.settings nav >> text=${section}`);
      await shot(page, `${theme}-${String(6 + index).padStart(2, "0")}-settings-${section.toLowerCase()}`);
    }
    // The devtools, docked under the thread, at each panel.
    await page.keyboard.press("Escape");
    await page.waitForSelector("textarea");
    await page.keyboard.press("ControlOrMeta+Shift+d");
    await page.waitForSelector(".devtools");
    for (const [index, panel] of ["Routes", "Navigation", "Host events", "Plugins", "Hooks", "Registries", "Inspectors"].entries()) {
      await page.click(`[aria-label='Devtools panels'] [role=tab] >> text=${panel}`);
      await shot(page, `${theme}-${String(11 + index).padStart(2, "0")}-devtools-${panel.toLowerCase().replace(" ", "-")}`);
    }
    await page.keyboard.press("ControlOrMeta+Shift+d");
    // The thread's Trajectory, and a request selected in it.
    await page.click(".view-tab[aria-label=Trajectory]");
    await page.waitForSelector(".trj-table tbody tr[data-record]");
    await shot(page, `${theme}-20-trajectory`);
    await page.click(".trj-table tbody tr[data-record]");
    await shot(page, `${theme}-21-trajectory-details`);
    // Settings › MCP servers, with a server selected.
    await page.keyboard.press("ControlOrMeta+,");
    await page.click(".settings nav >> text=MCP servers");
    await page.click(".mcp-row[data-server=github]");
    await shot(page, `${theme}-22-settings-mcp`);
    await page.close();
  }
  console.log(`Shots in ${out}`);
} finally {
  await browser.close();
  await server.close();
}
