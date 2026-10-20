import assert from "node:assert/strict";
import { boot, switchTo } from "./shared.ts";

/** The frames pages are drawn in, top to bottom: title, sandbox, height, and where each sits. */
const framesOf = (page: import("playwright").Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("iframe.html-frame")].map((frame) => {
      const box = frame.getBoundingClientRect();
      return { title: frame.getAttribute("title"), sandbox: frame.getAttribute("sandbox"), top: box.top, height: box.height };
    }),
  );

// 12: what tools draw. A script's calls show as they settle, and the pages tools draw show outside the fold, after the
// work and above the answer, once each, sandboxed, sized to their content, and following the app's look.
export const pages = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot();
  await page.evaluate(() => {
    (window as any).pageReports = [];
    addEventListener("message", (event) => {
      if (event.data?.type === "check-page") (window as any).pageReports.push(event.data);
    });
  });
  // Held after its first call until the check has seen it, however long the page takes to show it.
  await page.evaluate(() => (window as any).lemmaMock.holdScript());
  await page.fill("textarea", "Draw a page");
  await page.keyboard.press("Enter");

  // While the script runs, its line opens to the calls it has made so far.
  const script = page.locator(".tool-head", { hasText: "const log = await tools.bash" });
  await script.waitFor({ timeout: 20_000 });
  await script.click();
  await page
    .waitForFunction(() => document.querySelectorAll(".codemode-call").length >= 1 && document.querySelector(".tool.tool-running") !== null, undefined, {
      timeout: 10_000,
    })
    .catch(() => assert.fail("a running script's calls do not show as they settle"));
  assert.match(
    (await page.locator(".codemode-call").first().textContent()) ?? "",
    /✓bash\{"command":"git log --oneline -n 5"\}12ms/,
    "a running script's call does not show its name, arguments, and time",
  );
  await page.evaluate(() => (window as any).lemmaMock.releaseScript());

  await page.waitForFunction(() => document.querySelectorAll(".turn-footer").length === 1, undefined, { timeout: 30_000 });
  await page
    .waitForFunction(() => (window as any).pageReports.filter((report: any) => report.title === "Summary").length > 0, undefined, { timeout: 10_000 })
    .catch(() => assert.fail("a page drawn in the chat did not run its script"));
  const answerTop = await page.evaluate(() => {
    const answer = [...document.querySelectorAll(".turn p")].find((p) => p.textContent?.includes("Both pages are above"));
    return answer?.getBoundingClientRect().top;
  });
  const workBottom = await page.evaluate(() => document.querySelector(".work")?.getBoundingClientRect().bottom);
  const frames = await framesOf(page);
  assert.deepEqual(
    frames.map((frame) => frame.title),
    ["Commits", "Summary"],
    "the pages a script and the model drew are not each drawn once, in order",
  );
  assert.ok(
    frames.every((frame) => workBottom !== undefined && answerTop !== undefined && frame.top >= workBottom - 1 && frame.top < answerTop),
    "a page is not drawn after the turn's work and above its answer",
  );
  assert.equal(
    await page.locator(".tool-display").count(),
    frames.length,
    "a call that draws nothing outside the fold (a script that showed no page) leaves an empty box in the turn",
  );
  assert.ok(
    frames.every((frame) => frame.sandbox === "allow-scripts allow-forms"),
    "a page is not sandboxed with scripts and forms alone (never the app's origin)",
  );
  // Sized to their content (a heading and a 120px box), not the frame's first guess, nor nothing.
  await page
    .waitForFunction(
      () => {
        const frame = document.querySelector("iframe.html-frame[title='Summary']");
        const height = frame?.getBoundingClientRect().height ?? 0;
        return height > 140 && height < 159;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(async () => assert.fail(`a page's frame is not sized to its content: ${JSON.stringify(await framesOf(page))}`));
  const first = await page.evaluate(() => (window as any).pageReports.findLast((report: any) => report.title === "Summary"));
  assert.equal(first.reach, "SecurityError", "a page reaches into the app");
  const appBg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  assert.equal(first.bg, await appBg(), "a page does not have the app's theme");

  // Opening the work leaves each page drawn once, where it was, and the script that drew none still without a box.
  await page.click(".work-head");
  assert.deepEqual(
    (await framesOf(page)).map((frame) => frame.title),
    ["Commits", "Summary"],
    "opening the work draws a page again",
  );
  assert.equal(await page.locator(".tool-display").count(), 2, "opening the work leaves an empty box under a script that showed no page");

  // The look changes: the page follows it without loading again.
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(
    async (scheme) => {
      const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
      await (await (window as any).lemma.service(Client)).configure({ "look.appearance": { values: { scheme } } });
    },
    theme === "dark" ? "light" : "dark",
  );
  await page.waitForFunction((was) => document.documentElement.dataset.theme !== was, theme, { timeout: 5_000 });
  await page
    .waitForFunction(
      ({ bg, loaded }) => {
        const last = (window as any).pageReports.findLast((report: any) => report.title === "Summary");
        return last.bg === bg && last.loaded === loaded;
      },
      { bg: await appBg(), loaded: first.loaded },
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("a page does not follow the app's look, or loads again to"));

  const summary = page.locator("figure.html-render", { has: page.locator("iframe[title='Summary']") });
  const contentOf = async (frame: import("playwright").Locator) => (await (await frame.elementHandle())!.contentFrame())!;
  /** Where the chat's view starts, and where the Summary page's figure and buttons are, from the top of the window. */
  const places = () =>
    page.evaluate(() => {
      const scroller = document.querySelector(".chat-view .scroller")!.getBoundingClientRect();
      const figure = document.querySelector("figure.html-render:has(iframe[title='Summary'])")!;
      const box = figure.getBoundingClientRect();
      return { view: scroller.top, figure: { top: box.top, right: box.right }, actions: figure.querySelector(".html-render-actions")!.getBoundingClientRect() };
    });

  // Drawn again (its plugin off and on, as when a thread is shown again), a page's frame starts at the height it took,
  // rather than growing from a first guess.
  const took = await summary.locator("iframe").evaluate((frame) => Math.round(frame.getBoundingClientRect().height));
  await page
    .waitForFunction(
      (took) =>
        (JSON.parse(localStorage.getItem("lemma.tools.html.heights") ?? "[]") as { sizes: [number, number][] }[]).some((stored) =>
          stored.sizes.some(([, height]) => height === took),
        ),
      took,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("the height a page's frame took is not stored"));
  await switchTo(page, "tools.html", false);
  await page.evaluate(() => {
    const first: Record<string, string> = ((window as any).firstHeights = {});
    new MutationObserver(() => {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.html-frame"))
        if (!(frame.title in first) && frame.style.height !== "") first[frame.title] = frame.style.height;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
  });
  await switchTo(page, "tools.html", true);
  await summary.waitFor({ timeout: 5_000 });
  assert.equal(await page.evaluate(() => (window as any).firstHeights.Summary), `${took}px`, "a page drawn again does not start at the height it took");

  // A long page: its buttons sit beside it, where the chat has room, and stay at the top of the chat as it scrolls by.
  let content = await contentOf(summary.locator("iframe"));
  await content.evaluate(() => {
    (window as any).hashes = [];
    addEventListener("hashchange", () => (window as any).hashes.push(location.hash));
    document.body.insertAdjacentHTML(
      "beforeend",
      `<p><a id="to-far" href="#far">Far</a> <a id="to-deep" href="#deep">Deep</a> <a id="out" href="https://example.com/out">Out</a> <a id="own" href="https://example.com/own">Own</a></p>` +
        `<div id="box" style="height:100px;overflow:auto"><div style="height:600px"></div><p id="deep">Deep</p></div>` +
        `<div style="height:1200px"></div><p id="far">Far</p><div style="height:1200px"></div>`,
    );
    document.getElementById("own")!.addEventListener("click", (event) => event.preventDefault());
  });
  await page
    .waitForFunction(() => (document.querySelector("iframe[title='Summary']")?.getBoundingClientRect().height ?? 0) > 2500, undefined, { timeout: 5_000 })
    .catch(() => assert.fail("a page that grew long does not grow its frame"));
  assert.equal(await summary.locator(".html-render-rail.beside").count(), 1, "a page's buttons are not beside it, with room there");
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".chat-view .scroller")!;
    const figure = document.querySelector("figure.html-render:has(iframe[title='Summary'])")!;
    scroller.scrollTop += figure.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 800;
  });
  const scrolled = await places();
  await page.mouse.move(scrolled.figure.right - 200, scrolled.view + 300);
  await page
    .waitForFunction(
      () => getComputedStyle(document.querySelector("figure.html-render:has(iframe[title='Summary']) .html-render-actions")!).opacity === "1",
      undefined,
      {
        timeout: 3_000,
      },
    )
    .catch(() => assert.fail("a page's buttons do not show with the pointer over it"));
  const stuck = await places();
  assert.ok(Math.abs(stuck.actions.top - stuck.view - 8) <= 2, `a page's buttons do not stay at the top of the chat: ${JSON.stringify(stuck)}`);
  assert.ok(stuck.actions.left >= stuck.figure.right, `a page's buttons cover it, with room beside it: ${JSON.stringify(stuck)}`);

  // A link to a place in the page: the page follows it itself (its address, :target, hashchange, a box of its own
  // scrolled), and the chat scrolls to where the place is.
  // The page is as tall as its frame, so the place is where it is in the frame however the chat scrolls.
  const farInFrame = await content.evaluate(() => document.getElementById("far")!.getBoundingClientRect().top);
  await content.locator("#to-far").click();
  await page
    .waitForFunction(
      (farInFrame) => {
        const view = document.querySelector(".chat-view .scroller")!.getBoundingClientRect().top;
        const frame = document.querySelector("iframe[title='Summary']")!.getBoundingClientRect().top;
        return Math.abs(frame + farInFrame - view - 16) <= 3;
      },
      farInFrame,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("a link to a place in a page does not scroll the chat to it"));
  assert.deepEqual(
    await content.evaluate(() => ({ hash: location.hash, target: document.querySelector(":target")?.id, hashes: (window as any).hashes })),
    { hash: "#far", target: "far", hashes: ["#far"] },
    "a link to a place in a page is not followed by the page: its address, :target, and hashchange",
  );
  await content.locator("#to-deep").click();
  await content
    .waitForFunction(
      () => {
        const box = document.getElementById("box")!.getBoundingClientRect();
        const deep = document.getElementById("deep")!.getBoundingClientRect();
        return deep.top >= box.top - 1 && deep.bottom <= box.bottom + 1;
      },
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => assert.fail("a link to a place in a box of the page's own does not scroll the box"));

  // A link elsewhere opens in the person's browser, unless the page's own script took the click.
  await page.evaluate(() => {
    const opened: string[] = ((window as any).opened = []);
    window.open = (url?: string | URL) => (opened.push(String(url)), null);
  });
  await content.locator("#own").click();
  await content.locator("#out").click();
  // The page's messages arrive in order: once the second link's has, the first's would have.
  await page.waitForFunction(() => (window as any).opened.length > 0, undefined, { timeout: 3_000 }).catch(() => assert.fail("a link elsewhere does not open"));
  assert.deepEqual(
    await page.evaluate(() => (window as any).opened),
    ["https://example.com/out"],
    "a link the page's script took is opened too, or a link not",
  );

  // Full screen: the page over the app, filling the dialog, focus in the page; Tab out of its end comes round to the
  // dialog's close button, and Shift+Tab back into the page.
  await page.mouse.move(stuck.figure.right - 200, stuck.view + 300);
  await summary.getByRole("button", { name: "Open full screen" }).click();
  const viewer = page.locator(".dialog.html-viewer iframe.html-frame-fill[title='Summary']");
  await viewer.waitFor({ timeout: 5_000 }).catch(() => assert.fail("a page does not open full screen"));
  assert.ok(((await viewer.boundingBox())?.height ?? 0) > 600, "a page full screen does not fill the window");
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  await page
    .waitForFunction(() => document.activeElement?.tagName === "IFRAME", undefined, { timeout: 3_000 })
    .catch(async () => assert.fail(`full screen puts focus on ${await focused()}, not the page`));
  content = await contentOf(viewer);
  await content.waitForFunction(() => document.readyState === "complete" && document.title === "Summary", undefined, { timeout: 5_000 });
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "Close", "Tab out of a page full screen does not come round to the dialog's close button");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(), "IFRAME", "Shift+Tab from the dialog's close button does not go back into the page");

  // Escape the page has a use for (leaving a field, closing its own dialog) keeps it open; then Escape closes it.
  // Each Escape, once the page's bootstrap has had it, the page says so after anything the bootstrap said: once the app
  // hears that, it has heard whether the page asked it to close.
  await page.evaluate(() => {
    (window as any).escapes = 0;
    addEventListener("message", (event) => event.data?.type === "check-escaped" && (window as any).escapes++);
  });
  await content.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<input id="field"><dialog id="own-dialog">Own</dialog>`);
    addEventListener("keydown", (event) => event.key === "Escape" && setTimeout(() => parent.postMessage({ type: "check-escaped" }, "*"), 0));
  });
  const escaped = (count: number) => page.waitForFunction((count) => (window as any).escapes >= count, count, { timeout: 3_000 });
  await content.locator("#field").focus();
  await page.keyboard.press("Escape");
  await escaped(1);
  assert.equal(await viewer.count(), 1, "Escape in a field of a page full screen closes the page");
  await content.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    (document.getElementById("own-dialog") as HTMLDialogElement).showModal();
  });
  await page.keyboard.press("Escape");
  await escaped(2);
  assert.equal(await viewer.count(), 1, "Escape closing a page's own dialog closes the page full screen too");
  assert.equal(
    await content.evaluate(() => (document.getElementById("own-dialog") as HTMLDialogElement).open),
    false,
    "Escape does not reach a page's own dialog",
  );
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached", timeout: 5_000 }).catch(() => assert.fail("Escape pressed in a page full screen does not close it"));

  // In the pane: a tab named for the page shows it, filling the tab; opening it again, or another page, shows it there.
  await summary.hover();
  await summary.getByRole("button", { name: "Open in the pane" }).click();
  const inPane = page.locator(".html-page-view iframe.html-frame-fill[title='Summary']");
  await inPane.waitFor({ timeout: 5_000 }).catch(() => assert.fail("a page does not open in the pane"));
  const named = (title: string) => page.locator(".thread-inspector-tab", { hasText: title });
  assert.equal(await named("Summary").count(), 1, "a page in the pane does not name its tab");
  await summary.hover();
  await summary.getByRole("button", { name: "Open in the pane" }).click();
  assert.equal(await named("Summary").count(), 1, "opening a page in the pane again opens another tab rather than showing it in its own");
  assert.equal((await framesOf(page)).filter((frame) => frame.title === "Summary").length, 2, "a page in the pane is not drawn beside the chat's, once");
  const commits = page.locator("figure.html-render", { has: page.locator("iframe[title='Commits']") });
  await commits.hover();
  await commits.getByRole("button", { name: "Open in the pane" }).click();
  await page
    .locator(".html-page-view iframe.html-frame-fill[title='Commits']")
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("another page does not open in the pane"));
  assert.deepEqual([await named("Commits").count(), await named("Summary").count()], [1, 0], "another page opened in the pane does not show in the page's tab");

  expectNoErrors("drawing pages");
  return "a script's calls show as they run, and the pages tools draw show outside the fold, once, sandboxed, sized from the start, and following the look, with their links, full screen, and in the pane";
};
