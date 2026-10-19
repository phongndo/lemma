import assert from "node:assert/strict";
import { boot } from "./shared.ts";

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

  expectNoErrors("drawing pages");
  return "a script's calls show as they run, and the pages tools draw show outside the fold, once, sandboxed, sized, and following the look";
};
