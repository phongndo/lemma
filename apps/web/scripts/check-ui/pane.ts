import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { boot, showView } from "./shared.ts";

// 7: the thread's inspection pane: the trajectory, and who shaped a request, beside the chat; its tabs, width, and address.
export const pane = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot(await startHost());
  const where = () => page.evaluate(() => `${location.pathname}${location.search}`);
  // The seeded thread with requests, a failed call asked again, and a compaction, opened from its row.
  await page.click(".thread-open:has-text('Fix flaky session log test')");
  await page.waitForSelector(".turn");
  const thread = await where();

  // The trajectory opens in the thread's inspection pane, beside the chat, which stays. It opens at its newest row, and
  // scrolling up stops following it until Follow; a short window makes it scroll.
  await page.setViewportSize({ width: 1200, height: 320 });
  await showView(page, "trajectory");
  await page.waitForSelector(".thread-inspector .trj");
  assert.equal(await page.locator(".thread-chat .chat-view").count(), 1, "the chat went away when the trace opened beside it");
  const atNewest = (failure: string) =>
    page
      .waitForFunction(
        () => {
          const scroller = document.querySelector(".trj-scroll")!;
          return scroller.scrollHeight > scroller.clientHeight && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
        },
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => assert.fail(failure));
  await atNewest("the trajectory did not open at its newest row");
  await page.evaluate(() => document.querySelector(".trj-scroll")!.scrollTo({ top: 0 }));
  await page.click(".dt-chip >> text=Follow");
  await atNewest("Follow did not bring the trajectory back to its newest row");
  await page.setViewportSize({ width: 1200, height: 900 });
  // A model call's pipeline, from the log: the compaction its request made, its handlers, and why the turn stopped.
  await page.click(".trj tr[data-kind=assistant] >> nth=-1");
  await page.click("[aria-label='Event details'] [role=tab] >> text=Pipeline");
  await page.waitForSelector("[aria-label=Handlers] tr:has(td:text-is('context.compaction')) >> text=+compaction");
  await page.waitForSelector(".dt-section h4 >> text=Compaction");
  await page.waitForSelector(".dt-section h4 >> text=Then it stopped");
  // The answer of the step that asked a failed call again (the row after the failed attempt's): the attempt before it,
  // and that the turn went on.
  await page.click(".trj tr[data-kind=assistant] >> nth=1");
  await page.click("[aria-label='Event details'] [role=tab] >> text=Pipeline");
  await page.waitForSelector(".dt-section h4:has(span:text-is('Model')) .dt-section-aside >> text=1 failed first");
  await page.waitForSelector("[aria-label='Event details'] >> text=Answered");
  await page.waitForSelector(".dt-section h4 >> text=Then it went on");
  // A tool call's: who checked it.
  await page.click(".trj tr[data-kind=tool] >> nth=0");
  await page.click("[aria-label='Event details'] [role=tab] >> text=Pipeline");
  await page.waitForSelector("[aria-label=Guards] tr:has(td:text-is('plan-mode')) >> text=allowed");
  // Its + opens a view in a new tab, by the view's letter too, and another of one already open; only the tab shown is
  // drawn.
  const titles = () => page.locator(".thread-inspector-open").allTextContents();
  await page.click(".thread-inspector-head [aria-label='Open a view']");
  // The menu takes focus once it has opened, a frame after the click.
  await page.waitForFunction(() => document.activeElement?.closest(".popover") != null);
  await page.keyboard.press("b");
  await page.waitForSelector(".thread-inspector-view .browser-view");
  assert.equal(await page.locator(".thread-inspector .trj").count(), 0, "a tab not shown is still drawn");
  // A page lies over its place in the tab, drawn from the app's top.
  await page.fill(".browser-address", "about:blank");
  await page.keyboard.press("Enter");
  await page
    .waitForFunction(
      () => {
        const place = document.querySelector(".browser-place")!.getBoundingClientRect();
        const shown = document.querySelector(".browser-page")?.getBoundingClientRect();
        return shown !== undefined && [place.x, place.y, place.width, place.height].join() === [shown.x, shown.y, shown.width, shown.height].join();
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("a browser page is not over its place in the pane"));
  // In a browser, which keeps ⌘T and ⌘L from its pages, they stay the browser's: they are the desktop app's alone.
  const boundKeys = (id: string) =>
    page.evaluate(async (id) => {
      const { Actions } = (await import("/src/ui/api.ts" as string)).api.contracts;
      const action = (window as any).lemma.slots().get(Actions, id);
      return action === undefined ? "no action" : (action.keys ?? "no keys");
    }, id);
  assert.deepEqual(
    [await boundKeys("thread.inspect-new-tab"), await boundKeys("browser.address")],
    ["no keys", "no action"],
    "the app takes ⌘T or ⌘L from the browser",
  );
  await page.click(".thread-inspector-head [aria-label='Open a view']");
  await page.click(".popover [role=menuitem] >> text=Trace");
  await page.waitForFunction(() => document.querySelectorAll(".thread-inspector-open").length === 3);
  assert.deepEqual(await titles(), ["Trace", "Browser", "Trace"]);
  // A tab dragged by its name past its neighbor's middle takes its place on the drop.
  const [dragged, target] = [
    await page.locator(".thread-inspector-open >> nth=1").boundingBox(),
    await page.locator(".thread-inspector-tab >> nth=0").boundingBox(),
  ];
  await page.mouse.move(dragged!.x + dragged!.width / 2, dragged!.y + dragged!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 10, target!.y + target!.height / 2, { steps: 8 });
  await page.mouse.up();
  await page
    .waitForFunction(() => [...document.querySelectorAll(".thread-inspector-open")].map((tab) => tab.textContent).join() === "Browser,Trace,Trace", undefined, {
      timeout: 5_000,
    })
    .catch(async () => assert.fail(`dragging a pane tab left them as ${(await titles()).join(", ")}`));
  // Its right-click menu closes the others; the shown tab's × (⌘W with focus in the pane, in the desktop app: a browser
  // keeps ⌘W) closes it, and the last one the pane, the thread staying.
  await page.click(".thread-inspector-open >> nth=2", { button: "right" });
  await page.click(".popover [role=menuitem] >> text=Close others");
  assert.deepEqual(await titles(), ["Trace"]);
  await page.click(".thread-inspector-tab.shown .thread-inspector-close");
  await page.waitForSelector(".thread-inspector", { state: "detached" });
  assert.equal(await where(), thread, "closing the pane's last tab closed the thread");
  // With no tab it never opens empty: its switch offers the views, and the tab picked takes focus.
  await page.click("[aria-label='Open inspection pane']");
  await page.click(".popover [role=menuitem] >> text=Trace");
  await page.waitForSelector(".thread-inspector-view .trj");
  await page
    .waitForFunction(() => document.activeElement?.matches(".thread-inspector-tab.shown .thread-inspector-open") === true, undefined, { timeout: 3_000 })
    .catch(() => assert.fail("a view picked from the pane's switch does not take focus"));
  // ⌘I offers them too, by letter, and closes its menu again.
  await page.click(".thread-inspector-tab.shown .thread-inspector-close");
  await page.waitForSelector(".thread-inspector", { state: "detached" });
  const menuFocused = () => page.waitForFunction(() => document.activeElement?.closest(".popover") != null);
  await page.keyboard.press("ControlOrMeta+i");
  await menuFocused();
  assert.equal(await page.locator(".thread-inspector").count(), 0, "the pane opened with no tab");
  await page.keyboard.press("ControlOrMeta+i");
  await page.waitForSelector(".popover", { state: "detached", timeout: 3_000 }).catch(() => assert.fail("⌘I does not close the menu of views it opened"));
  await page.keyboard.press("ControlOrMeta+i");
  await menuFocused();
  await page.keyboard.press("t");
  await page.waitForSelector(".thread-inspector-view .trj");
  // It opens at 40% of the page, no narrower than 480px; dragged, it takes a share of the page, which it keeps as the
  // window changes; a double-click on its edge gives it its first width.
  const paneWidth = () => page.evaluate(() => document.querySelector(".thread-inspector")!.getBoundingClientRect().width);
  const share = () =>
    page.evaluate(() => {
      const pane = document.querySelector(".thread-inspector")!.getBoundingClientRect().width;
      return Math.round((pane / document.querySelector(".main")!.getBoundingClientRect().width) * 100);
    });
  assert.equal(await paneWidth(), 480, "the pane does not open at its first width");
  const edge = (await page.locator(".thread-inspector-edge").boundingBox())!;
  const main = (await page.locator(".main").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(main.x + main.width * 0.5, edge.y + 200, { steps: 4 });
  await page.mouse.up();
  assert.equal(await share(), 50, "dragging the pane's edge does not set its share");
  await page.setViewportSize({ width: 1500, height: 900 });
  assert.equal(await share(), 50, "the pane does not keep its share as the window widens");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.dblclick(".thread-inspector-edge");
  assert.equal(await paneWidth(), 480, "a double-click on the pane's edge does not give it its first width");
  await page.setViewportSize({ width: 1800, height: 900 });
  assert.equal(await share(), 40, "the pane does not open at 40% of a wide page");
  await page.setViewportSize({ width: 1200, height: 900 });
  // Maximized, it fills the page, the chat out of sight; restored, the chat is back.
  await page.click("[aria-label='Maximize inspection pane']");
  await page.waitForFunction(() => document.querySelector(".thread-chat")!.getBoundingClientRect().width === 0);
  await page.click("[aria-label='Restore inspection pane']");
  await page.waitForFunction(() => document.querySelector(".thread-chat")!.getBoundingClientRect().width > 0);
  // An address naming a view shows the thread's tab of it, rather than another, then names the thread alone.
  const threadPath = await page.evaluate(async () => {
    const { Router } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const path = location.pathname;
    (await (window as any).lemma.service(Router)).navigate(`${path}/trajectory`);
    return path;
  });
  await page.waitForFunction((path) => location.pathname === path, threadPath);
  assert.deepEqual(await titles(), ["Trace"], "an address naming a view opened another tab of it");
  // The pane is the thread's: another shows its own, and this one's is as it was on coming back.
  const other: string = await page.evaluate(async (current) => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const threads = await (window as any).lemma.service(Threads);
    const next = threads.list().find((session: { id: string; lastSeq: number }) => !current.includes(session.id) && session.lastSeq > 0).id;
    await threads.select(next);
    return next;
  }, thread);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, other);
  assert.equal(await page.locator(".thread-inspector").count(), 0, "another thread showed this one's pane");
  await page.goBack();
  await page.waitForSelector(".thread-inspector .trj");
  // Its switch closes it; the header's opens it again at the tab it showed.
  await page.click("[aria-label='Close inspection pane']");
  await page.waitForSelector(".thread-inspector", { state: "detached" });
  await page.click("[aria-label='Open inspection pane']");
  await page.waitForSelector(".thread-inspector .trj");
  await page.click("[aria-label='Close inspection pane']");
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread);
  await page.waitForSelector(".turn");
  // Settings reloaded, then another section: closing still returns to the thread. Over Settings, the pane's keys leave it
  // as it was.
  await page.keyboard.press("ControlOrMeta+,");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  await page.keyboard.press("ControlOrMeta+i");
  await page.reload();
  await page.click(".settings-nav-item >> text=Plugins");
  await page.waitForFunction(() => location.pathname === "/settings/plugins");
  await page.keyboard.press("Escape");
  await page
    .waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 })
    .catch(async () => assert.fail(`closing settings after a reload went to ${await where()}`));
  assert.equal(await page.locator(".thread-inspector").count(), 0, "⌘I over Settings opened the thread's pane");
  expectNoErrors("using the inspection pane");
  return "a trajectory record's pipeline says who shaped it; the pane's tabs open, move, and close, keep a width, maximize, follow the address, and are each thread's own";
};
