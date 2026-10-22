import assert from "node:assert/strict";
import type { Page } from "playwright";
import { boot, drawn, settled, url } from "./shared.ts";

/** The tab of the thread titled `title`, across the top. */
const tab = (page: Page, title: string) => page.locator(".tab-strip .tab-item", { has: page.locator(".tab-title", { hasText: title }) });
const titles = (page: Page) => page.$$eval(".tab-strip .tab-title", (all) => all.map((title) => title.textContent));

/**
 * Drags the tab of `title` by the pointer, as a person does: pressed, moved a little so the drag starts, then to the
 * middle of what `onto` finds once the sections are named, where it says what dropping it does (`verb`), and let go.
 */
const dragTab = async (page: Page, title: string, onto: string, verb: string) => {
  const from = (await tab(page, title).boundingBox())!;
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + 40, y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, y, { steps: 4 });
  await page.waitForSelector(".tab-head-label", { timeout: 5_000 }).catch(() => assert.fail("a tab dragged does not name the sections"));
  const to = (await page.locator(onto).boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, y, { steps: 24 });
  await page
    .waitForFunction((verb) => document.querySelector(".tab-verb")?.textContent === verb, verb, { timeout: 5_000 })
    .catch(async () =>
      assert.fail(
        `a tab dragged onto ${onto} says "${await page
          .locator(".tab-verb")
          .textContent()
          .catch(() => "")}", not ${verb}`,
      ),
    );
  await page.mouse.up();
  await page.waitForSelector(".tab-head-label", { state: "detached", timeout: 5_000 });
};

// 13. The threads as tabs across the top: the sidebar's list, archived, ordered, and pinned alike.
export const tabs = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot();
  // Settings › Appearance › Layout puts the threads across the top, as their plugin's config.
  await page.goto(`${url}/settings/appearance?mock`);
  await settled(page);
  await page.click("[role=radiogroup][aria-label=Tabs] [role=radio] >> text=Horizontal");
  await page.waitForSelector(".tab-strip", { timeout: 10_000 }).catch(() => assert.fail("choosing horizontal tabs did not draw them across the top"));
  assert.equal(
    await page.evaluate(() => (window as any).lemma.plugins.list().find((plugin: any) => plugin.id === "frame.threads").config?.values.tabs),
    "horizontal",
    "the tabs' layout is not the plugin's config",
  );
  await page.click("[aria-label='Close settings']");
  await page.waitForFunction(() => location.pathname.startsWith("/threads/") || location.pathname === "/");
  assert.equal(await page.locator(".sidebar").count(), 0, "a sidebar shows beside the tabs");
  const listed = await titles(page);
  for (const title of ["Fix flaky session log test", "Refactor the session log reader", "Landing page copy"])
    assert(listed.includes(title), `"${title}" is not a tab: ${listed.join(", ")}`);

  // × archives a tab, which Archived at the bar's end counts and lists; unarchived there, it is a tab again.
  await tab(page, "Landing page copy").hover();
  await page.click("[aria-label='Archive Landing page copy']");
  await tab(page, "Landing page copy").waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector(".tab-archived-trigger")?.textContent?.trim() === "1", undefined, { timeout: 5_000 });
  await page.click(".tab-archived-trigger");
  await page.waitForSelector(".tab-menu .menu-item >> text=Landing page copy", { timeout: 5_000 });
  await page.click("[aria-label='Unarchive Landing page copy']");
  await tab(page, "Landing page copy").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");

  // Dragged into the pinned, a tab is pinned there, apart from the rest; its pin under the pointer unpins it.
  await dragTab(page, "Refactor the session log reader", ".tab-head.pinned", "Pin");
  await tab(page, "Refactor the session log reader").locator("[data-mark=pinned]").waitFor({ timeout: 5_000 });
  assert.equal(await page.locator(".tab-head.active .tab-rule").count(), 1, "no divider between the pinned tabs and the rest");
  // The keys that go to each listed thread show on its tab while mod is held.
  await page.keyboard.down("ControlOrMeta");
  await page
    .waitForFunction(() => document.querySelectorAll(".tab-keys").length >= 3, undefined, { timeout: 5_000 })
    .catch(() => assert.fail("holding mod does not show the tabs' keys"));
  assert.match((await tab(page, "Refactor the session log reader").locator(".tab-keys").textContent()) ?? "", /1$/, "the pinned tab is not the first key's");
  await page.keyboard.up("ControlOrMeta");
  // A moment's pointing shows its details, and the count of its agents opens them.
  await tab(page, "Refactor the session log reader").locator(".tab-open").hover();
  await page.waitForSelector(".thread-details >> text=lemma", { timeout: 5_000 }).catch(() => assert.fail("pointing at a tab does not show its details"));
  await tab(page, "Refactor the session log reader").locator(".tab-agents").click();
  await page.waitForSelector(".tab-menu .menu-section >> text=3 agents", { timeout: 5_000 }).catch(() => assert.fail("a tab's agents do not open"));
  await page.keyboard.press("Escape");
  await tab(page, "Refactor the session log reader").hover();
  await page.click("[aria-label='Unpin Refactor the session log reader']");
  await page.waitForFunction(() => document.querySelector(".tab-mark[data-mark=pinned]") === null, undefined, { timeout: 5_000 });

  // Dragged onto Archived, a tab is archived.
  await dragTab(page, "Fix flaky session log test", ".tab-archived", "Archive");
  await tab(page, "Fix flaky session log test").waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector(".tab-archived-trigger")?.textContent?.trim() === "1", undefined, { timeout: 5_000 });

  // Pinned again across the top, it is pinned down the side too: one list, two layouts.
  await dragTab(page, "Landing page copy", ".tab-head.pinned", "Pin");
  await page.evaluate(async () => {
    const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
    await (await (window as any).lemma.service(Client)).configure({ "frame.threads": { values: { tabs: null } } });
  });
  await page.waitForSelector(".sidebar .thread-row", { timeout: 10_000 }).catch(() => assert.fail("the default does not list the threads down the sidebar"));
  await drawn(page);
  assert.equal(await page.locator(".tab-strip").count(), 0, "the tabs stay across the top beside the sidebar");
  assert.equal(
    await page.locator("[data-section=pinned] .thread-row", { hasText: "Landing page copy" }).count(),
    1,
    "a tab pinned across the top is not pinned down the side",
  );
  expectNoErrors("the threads as tabs across the top");
  return "the threads go across the top from Settings, as tabs archived with × and unarchived from Archived, dragged to pin and to archive, their keys held, their details and agents shown, and back down the side as they were";
};
