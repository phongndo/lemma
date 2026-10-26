import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { boot, checkPlugin, settled } from "./shared.ts";

// 4: a part replaced, everywhere, and one that fails left out for the default.
export const parts = async (): Promise<string> => {
  const { page, errors, expectNoErrors } = await boot(await startHost());
  // The threads are listed down the sidebar. A sidebar collapsed is remembered across a reload, and opened again it draws.
  await page.waitForSelector(".sidebar .thread-row", { timeout: 5_000 }).catch(() => assert.fail("the threads are not listed down the sidebar"));
  await page.evaluate(() => localStorage.setItem("lemma.sidebar.collapsed", "1"));
  await page.reload();
  await settled(page);
  await page.waitForFunction(() => "lemma" in window && (window as any).lemma.plugins.list().length > 0);
  await page.keyboard.press("ControlOrMeta+b");
  await page
    .waitForSelector(".sidebar .sidebar-head", { timeout: 5_000 })
    .catch(() => assert.fail("the sidebar did not draw after a reload with it collapsed"));
  expectNoErrors("a reload with the sidebar collapsed");
  await checkPlugin(page);

  // 4. A replaced part renders instead of the default, everywhere, and the default returns.
  await page.fill("textarea", "hello");
  // The new thread's page becomes the thread's mid-send, keeping its composer (a refused prompt's text returns to it).
  await page.evaluate(() => ((document.querySelector("textarea") as any).checkMark = true));
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  assert(page.url().includes("/threads/"), "the first prompt did not move to the thread's address");
  assert.equal(await page.evaluate(() => (document.querySelector("textarea") as any).checkMark), true, "the first prompt remounted the composer");
  assert((await page.locator(".turn .md").count()) > 0, "the default markdown part renders");
  // Model HTML in markdown is made safe to show: no script, image, control, or styling of its own, and links open outside.
  const sanitized = await page.evaluate(async () => {
    const { markdownBlocks } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const source = `<p class="toast" style="position: fixed" id="over" onclick="alert(1)">hi <a href="https://example.com">a link</a></p>\n\n<img src="https://example.com/x.png"><script>alert(1)</script><button>go</button>`;
    return markdownBlocks(source)
      .map((block: { kind: string; html?: () => string }) => (block.kind === "html" ? block.html!() : ""))
      .join("");
  });
  assert.match(
    sanitized,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">a link<\/a>/,
    `a link in markdown does not open outside: ${sanitized}`,
  );
  assert.doesNotMatch(sanitized, /<img|<script|<button|class=|style=|id=|onclick/, `model HTML in markdown is not sanitized: ${sanitized}`);
  await page.evaluate(async () => {
    const { MarkdownPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const remove = (window as any).checkSlots.add(MarkdownPart, {
      id: "check.markdown",
      component: (props: { text: string }) => {
        const element = document.createElement("div");
        element.className = "replaced-markdown";
        element.textContent = props.text;
        return element;
      },
    });
    (window as any).removeReplacement = remove;
  });
  await page.waitForSelector(".replaced-markdown");
  assert.equal(await page.locator(".turn .md").count(), 0, "the default markdown part still renders beside its replacement");
  await page.evaluate(() => (window as any).removeReplacement());
  await page.waitForSelector(".turn .md");
  assert.equal(await page.locator(".replaced-markdown").count(), 0, "the replacement outlives its removal");
  expectNoErrors("replacing a part");
  // The file icons are a better default than kit's: first among the defaults, which a replacement such as the one
  // above, naming no phase, comes before.
  assert.deepEqual(
    await page.evaluate(async () => {
      const { FileIconPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (window as any).lemma
        .slots()
        .contributions(FileIconPart)
        .map((contribution: any) => [contribution.item.id, contribution.phase]);
    }),
    [
      ["file-icons", "default"],
      ["kit.file-icon", "default"],
    ],
    "the file icons do not come first among the file icon part's defaults",
  );
  // A replacement that throws while drawing is left out for the default, its failure named for its plugin, and the
  // app keeps updating: a later turn still draws.
  await page.evaluate(async () => {
    const { MarkdownPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (window as any).removeBroken = (window as any).checkSlots.add(MarkdownPart, {
      id: "check.broken-markdown",
      component: () => {
        throw new Error("check markdown boom");
      },
    });
  });
  await page.waitForFunction(async () => {
    const { MarkdownPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
    return (window as any).lemma.slots().failures(MarkdownPart).length === 1;
  });
  assert.deepEqual(
    await page.evaluate(async () => {
      const { MarkdownPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (window as any).lemma
        .slots()
        .failures(MarkdownPart)
        .map((failure: any) => [failure.item.id, failure.pluginId, failure.error.message]);
    }),
    [["check.broken-markdown", "check", "check markdown boom"]],
    "the failing part is not named for its plugin",
  );
  await page.waitForSelector(".turn .md");
  const turns = await page.locator(".turn").count();
  await page.fill("textarea", "again");
  await page.keyboard.press("Enter");
  await page.waitForFunction((before) => document.querySelectorAll(".turn .md").length > before, turns, { timeout: 20_000 });
  assert(await page.locator(".toast >> text=check markdown boom").count(), "the failing part's fault is not reported");
  await page.evaluate(() => (window as any).removeBroken());
  assert(
    errors.some((error) => error.includes("check markdown boom")),
    "the failing part is not logged",
  );
  errors.splice(0);
  return "the threads list down the sidebar, kept collapsed across a reload; a part replaced and restored; a replacement that throws is left out for the default, named for its plugin";
};
