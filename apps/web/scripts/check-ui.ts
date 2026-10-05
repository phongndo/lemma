import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import type { Page } from "playwright";
import { createServer } from "vite";

/**
 * The web app's replaceability, checked on the real composition: the dev
 * server with the in-browser mock host (`?mock`), in Chromium. It holds the
 * invariant in apps/web/AGENTS.md at runtime, where `check-boundaries` holds
 * it in the imports:
 *
 * 1. The app boots without errors.
 * 2. Every part declared in `ui/contracts.ts` has a provider.
 * 3. Every plugin that is not pinned turns off and back on, as the Plugins
 *    page does it, and the page stays up and error-free either way.
 * 4. A part replaced by a lower-order item changes what renders, and the
 *    default returns when the replacement goes.
 * 5. A plugin's stylesheet leaves when it stops and returns once when it starts.
 * 6. What a plugin adds to the places the defaults use (header, sidebar and
 *    composer buttons, workspace bar, palette sources, inspector tabs) shows.
 *    Typing `@` offers the project's files and a pick writes the mention; a
 *    plugin's completion source answers its own trigger, Escape and Tab work
 *    in the menu, and its rows are a replaceable part. Enter waits for
 *    suggestions on their way, and a picked folder narrows to what is in it.
 * 7. The address names the page: settings sections and their state, threads
 *    and their views survive a reload and back and forward; a page whose
 *    plugin is off says so and returns with it; a plugin adds a page; a page
 *    that throws fails alone; routes in conflict are reported; a hovered
 *    thread link preloads; a deleted thread's address leaves for a new
 *    thread; an unsent prompt outlives settings and makes leaving the page ask.
 * 8. The devtools dock under the app, and each panel shows it as it runs.
 * 9. While a turn runs, the composer steers it or queues a prompt for after
 *    it; a queued prompt can be withdrawn (its row is a replaceable part), and
 *    a steer shows in its turn. A send that fails is retried with its request
 *    id, until the prompt is edited.
 * 10. The prompt rail has a tick per prompt; the one pointed at, or chosen with
 *    the keys, shows its prompt in a card level with it, and a click or Enter
 *    goes there, lighting it; the previous and next buttons move a turn each.
 * 11. With no provider set up, the app opens in the chat; the composer's notice
 *    opens Providers, which goes back to the chat once one connects.
 *
 * Run it in the browser shell: `nix develop .#browser -c pnpm --filter @lemma/web ui:check`.
 * `LEMMA_BROWSER=firefox` or `webkit` runs it in Playwright's builds of those
 * (`pnpm exec playwright install firefox webkit`; `PLAYWRIGHT_BROWSERS_PATH`
 * puts them elsewhere): history timing differs between engines.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const address = server.httpServer?.address();
assert(address !== null && typeof address === "object", "the dev server has no address");
const url = `http://127.0.0.1:${address.port}`;
// `LEMMA_BROWSER=firefox` or `webkit` runs it in Playwright's builds of those (`playwright install firefox webkit`).
const engine = { chromium, firefox, webkit }[process.env.LEMMA_BROWSER ?? "chromium"];
assert(engine !== undefined, `LEMMA_BROWSER is chromium, firefox, or webkit, not "${process.env.LEMMA_BROWSER}"`);
const executablePath = engine === chromium ? process.env.LEMMA_CHROMIUM : undefined;
const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

const errors: string[] = [];
const expectNoErrors = (when: string) => {
  const found = errors.splice(0);
  assert.deepEqual(found, [], `errors ${when}`);
};
/** Resolves once the page has a frame drawn by whatever fills `root`. */
const settled = (page: Page) => page.waitForFunction(() => document.querySelector("#root")!.childElementCount > 0, undefined, { timeout: 10_000 });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.waitForFunction(() => "lemma" in window && (window as any).lemma.plugins.list().length > 0);
  expectNoErrors("while booting");

  // 2. Every declared part has a provider.
  const unfilled: string[] = await page.evaluate(async () => {
    const contracts = await import("/src/ui/contracts.ts" as string);
    const slots = (window as any).lemma.slots();
    return Object.values(contracts)
      .filter((value: any) => typeof value?.name === "string" && value.name.startsWith("part."))
      .filter((part: any) => slots.first(part) === undefined)
      .map((part: any) => part.name);
  });
  assert.deepEqual(unfilled, [], "parts nothing provides");

  // 3. Every plugin turns off and on, the way the Plugins page switches it; a locked one (pinned, or needed by one) stays on.
  const plugins: { id: string; locked: boolean }[] = await page.evaluate(() =>
    (window as any).lemma.plugins.list().map((plugin: any) => ({ id: plugin.id, locked: plugin.locked !== undefined })),
  );
  const switchTo = (id: string, enabled: boolean) =>
    page.evaluate(
      async ({ id, enabled }) => {
        const lemma = (window as any).lemma;
        const plugin = lemma.plugins.list().find((candidate: any) => candidate.id === id);
        await lemma.plugins.setEnabled(plugin, enabled);
        return lemma.plugins.list().find((candidate: any) => candidate.id === id).state;
      },
      { id, enabled },
    );
  const toggled: string[] = [];
  const locked: string[] = [];
  for (const { id, locked: isLocked } of plugins) {
    if (id === "client") continue;
    const stylesheets = () => page.evaluate((plugin) => document.head.querySelectorAll(`style[data-plugin="${plugin}"]`).length, id);
    const styled = await stylesheets();
    const stateOff = await switchTo(id, false);
    await settled(page);
    expectNoErrors(`turning ${id} off`);
    if (isLocked) {
      assert.equal(stateOff, "active", `${id} is locked but turned off`);
      locked.push(id);
    } else {
      assert.notEqual(stateOff, "active", `${id} did not turn off`);
      // Its styles leave with it, so nothing it drew styles a replacement.
      assert.equal(await stylesheets(), 0, `${id} left its stylesheet behind`);
    }
    await switchTo(id, true);
    await settled(page);
    expectNoErrors(`turning ${id} back on`);
    assert.equal(await stylesheets(), styled, `${id} came back with ${await stylesheets()} stylesheets, not ${styled}`);
    toggled.push(id);
  }
  const off = await page.evaluate(() =>
    (window as any).lemma.plugins
      .list()
      .filter((plugin: any) => plugin.state !== "active")
      .map((plugin: any) => plugin.id),
  );
  assert.deepEqual(off, [], "plugins not back on after the round trip");

  // 4. A replaced part renders instead of the default, everywhere, and the default returns.
  await page.fill("textarea", "hello");
  // The new thread's page becomes the thread's mid-send, keeping its composer (a refused prompt's text returns to it).
  await page.evaluate(() => ((document.querySelector("textarea") as any).checkMark = true));
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  assert(page.url().includes("/threads/"), "the first prompt did not move to the thread's address");
  assert.equal(await page.evaluate(() => (document.querySelector("textarea") as any).checkMark), true, "the first prompt remounted the composer");
  assert((await page.locator(".turn .md").count()) > 0, "the default markdown part renders");
  await page.evaluate(async () => {
    const { MarkdownPart } = await import("/src/ui/contracts.ts" as string);
    const remove = (window as any).lemma.slots().add(MarkdownPart, {
      id: "check.markdown",
      order: 0,
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

  // 6. What a plugin adds to the places the defaults use renders there: a marker in each.
  const marker = (slot: string, extra: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ slot, extra }) => {
        const contracts = await import("/src/ui/contracts.ts" as string);
        const component = () => {
          const element = document.createElement("span");
          element.className = `check-marker check-${slot}`;
          element.textContent = slot;
          return element;
        };
        const remove = (window as any).lemma.slots().add(contracts[slot], { id: `check.${slot}`, order: 1_000, component, ...extra });
        ((window as any).removals ??= []).push(remove);
      },
      { slot, extra },
    );
  await marker("ThreadHeader", { side: "end" });
  await marker("SidebarActions");
  await marker("ComposerActions");
  await marker("WorkspaceBarItems", { side: "start" });
  for (const slot of ["ThreadHeader", "SidebarActions", "ComposerActions", "WorkspaceBarItems"]) {
    await page.waitForSelector(`.check-${slot}`, { timeout: 5_000 }).catch(() => assert.fail(`${slot} does not render what a plugin adds`));
  }
  // A palette source: its items come up in the palette, and its prefix narrows to it.
  await page.evaluate(async () => {
    const { PaletteSources } = await import("/src/ui/contracts.ts" as string);
    const remove = (window as any).lemma.slots().add(PaletteSources, {
      id: "check.source",
      order: 1_000,
      label: "checks",
      heading: "Checks",
      prefix: "!",
      items: () => [{ key: "check:one", title: "Check item one", run: () => {} }],
    });
    ((window as any).removals ??= []).push(remove);
  });
  await page.keyboard.press("ControlOrMeta+k");
  await page.fill(".palette-input input", "!");
  await page.waitForSelector(".palette-row >> text=Check item one", { timeout: 5_000 }).catch(() => assert.fail("a palette source's items do not show"));
  // Escape clears the search, then closes.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".palette", { state: "detached" });
  // Completions: the bundled `@` finds the project's files, and Enter writes the pick in place of the word.
  await page.click("textarea");
  await page.keyboard.type("see @compo");
  await page
    .waitForSelector(".completions .completion >> text=Composer.tsx", { timeout: 5_000 })
    .catch(() => assert.fail("typing @ does not offer the project's files"));
  // Its rows draw the `file-icon` part, which the `file-icons` plugin fills by type.
  assert.equal(
    await page.locator('.completion:has-text("Composer.tsx") .file-type[data-type="react"]').count(),
    1,
    "a file's row does not show its type's icon",
  );
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("textarea"), "see @src/components/Composer.tsx ", "picking a file does not write its mention");
  await page.waitForSelector(".completions", { state: "detached" });
  // A plugin's source answers its own trigger; Escape closes the menu until the word is left, and Tab picks.
  await page.evaluate(async () => {
    const { ComposerCompletions, ComposerSuggestionPart } = await import("/src/ui/contracts.ts" as string);
    const slots = (window as any).lemma.slots();
    ((window as any).removals ??= []).push(
      slots.add(ComposerCompletions, {
        id: "check.completion",
        order: 1_000,
        trigger: "#",
        label: "Checks",
        suggest: (query: string) => [{ key: "one", label: `Check ${query}`, insert: "#checked" }],
      }),
    );
    // Its rows draw through the `composer.suggestion` part, which a plugin replaces.
    (window as any).removeSuggestion = slots.add(ComposerSuggestionPart, {
      id: "check.suggestion",
      order: 0,
      component: (props: { suggestion: { label: string } }) => {
        const element = document.createElement("span");
        element.className = "replaced-suggestion";
        element.textContent = props.suggestion.label;
        return element;
      },
    });
  });
  await page.keyboard.type("#x");
  await page
    .waitForSelector(".completion .replaced-suggestion >> text=Check x", { timeout: 5_000 })
    .catch(() => assert.fail("a plugin's completions do not show"));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".completions", { state: "detached" });
  await page.keyboard.type("y");
  assert.equal(await page.locator(".completions").count(), 0, "a dismissed word reopens its menu while it is typed on");
  await page.keyboard.type(" #z");
  await page.evaluate(() => (window as any).removeSuggestion());
  await page
    .waitForSelector(".completion .menu-label >> text=Check z", { timeout: 5_000 })
    .catch(() => assert.fail("the default suggestion row does not return"));
  await page.keyboard.press("Tab");
  assert.equal(await page.inputValue("textarea"), "see @src/components/Composer.tsx #xy #checked ", "Tab does not pick the suggestion");
  // Enter while the answer is on its way waits for it, rather than sending a half-typed mention.
  await page.fill("textarea", "");
  await page.keyboard.type("@READ");
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("textarea"), "@READ", "Enter sent the prompt while its suggestions loaded");
  await page.waitForSelector(".completion >> text=README.md", { timeout: 5_000 });
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("textarea"), "@README.md ", "Enter does not pick once the suggestions arrive");
  // A folder picked goes on completing inside it, and only inside it.
  await page.keyboard.type("@src");
  const folderRow = () =>
    page.evaluate(() => [...document.querySelectorAll(".completion")].findIndex((row) => row.querySelector(".menu-label")?.textContent === "src"));
  await page.waitForFunction(() => [...document.querySelectorAll(".completion .menu-label")].some((label) => label.textContent === "src"), undefined, {
    timeout: 5_000,
  });
  await page
    .locator(".completion")
    .nth(await folderRow())
    .click();
  assert.equal(await page.inputValue("textarea"), "@README.md @src/", "picking a folder does not leave it open to type on");
  await page.waitForSelector('.completions [role="listbox"][aria-busy="false"]', { timeout: 5_000 });
  const outside: string[] = await page.evaluate(() =>
    [...document.querySelectorAll(".completion")]
      .map((row) => `${row.querySelector(".menu-hint")?.textContent ?? ""}/${row.querySelector(".menu-label")?.textContent ?? ""}`)
      .filter((path) => !path.startsWith("src/") || path === "src/src"),
  );
  assert.deepEqual(outside, [], "inside a picked folder, the menu offers what is outside it");
  await page.fill("textarea", "");
  expectNoErrors("completing in the composer");
  // An inspector tab: it lists for the selected plugin.
  await page.evaluate(async () => {
    const { PluginTabs, Settings } = await import("/src/ui/contracts.ts" as string);
    const lemma = (window as any).lemma;
    const remove = lemma.slots().add(PluginTabs, { id: "check.tab", order: 1_000, label: () => "Checked", component: () => document.createElement("span") });
    ((window as any).removals ??= []).push(remove);
    (await lemma.service(Settings)).open("plugins");
  });
  await page.waitForSelector(".inspector-table [role=row] >> nth=1");
  await page.click(".inspector-table [role=row] >> nth=1");
  await page.waitForSelector(".inspector-tabs >> text=Checked", { timeout: 5_000 }).catch(() => assert.fail("an inspector tab does not show"));
  await page.evaluate(() => {
    for (const remove of (window as any).removals) remove();
  });
  await page.waitForFunction(() => document.querySelectorAll(".check-marker").length === 0);
  expectNoErrors("adding to the extension slots");

  // 7. The address names what shows: a settings section and its state, a thread and its view. Reloads, back and forward,
  // and links return to them; a page whose plugin is off says so and comes back with it; a plugin adds a page of its own.
  const where = () => page.evaluate(() => `${location.pathname}${location.search}`);
  const selected = await page.evaluate(() => {
    const row = document.querySelector(".inspector-table [aria-selected=true] .plugin-id");
    return row?.textContent ?? undefined;
  });
  assert(selected !== undefined, "no plugin is selected on the Plugins page");
  assert.match(await where(), new RegExp(`^/settings/plugins\\?mock=.*plugin=${selected}`), "the selected plugin is not in the address");
  await page.reload();
  await page
    .waitForSelector(`.inspector-table [aria-selected=true] >> text=${selected}`, { timeout: 10_000 })
    .catch(() => assert.fail("a reload loses the selected plugin"));
  // Closing settings returns to the thread they were opened over.
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => location.pathname.startsWith("/threads/"), undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`closing settings went to ${await where()}`));
  // A seeded thread (the mock host forgets threads made since it started when the page reloads), opened from its row.
  const created = (await where()).split("/")[2]!.split("?")[0]!;
  const seeded: string = await page.evaluate(async (created) => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    const threads = await (window as any).lemma.service(Threads);
    return threads.list().find((session: any) => session.id !== created && session.lastSeq > 0 && session.archived !== true).id;
  }, created);
  await page.click(`.session-open[href^="/threads/${seeded}"]`);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, seeded);
  const thread = await where();
  await page.reload();
  await page.waitForSelector(".turn", { timeout: 10_000 }).catch(() => assert.fail("a reload does not reopen the thread"));
  // A saved position out of reach (the window grew) ends at the nearest, and scrolling is remembered again after.
  await page.evaluate(async () => {
    const { Router } = await import("/src/ui/contracts.ts" as string);
    (await (window as any).lemma.service(Router)).entry("chat.scroll").set(1_000_000);
  });
  await page.reload();
  await page.waitForSelector(".turn");
  await page.waitForTimeout(300);
  // The seeded thread may not scroll at all, so the reader's scroll is an event, not a move.
  await page.evaluate(() => document.querySelector(".chat-view .scroller")!.dispatchEvent(new Event("scroll")));
  await page.waitForTimeout(200);
  assert.notEqual(
    await page.evaluate(async () => {
      const { Router } = await import("/src/ui/contracts.ts" as string);
      return (await (window as any).lemma.service(Router)).entry("chat.scroll").get();
    }),
    1_000_000,
    "an unreachable saved position kept the chat from remembering scrolls",
  );
  // A view is in the address, and back returns to the one before.
  // The trajectory opens at its newest row, and scrolling up stops following it until Follow; a short window makes it scroll.
  await page.setViewportSize({ width: 1200, height: 320 });
  await page.click(".view-tab[aria-label=Trajectory]");
  await page.waitForFunction(() => location.pathname.endsWith("/trajectory"));
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
  await page.goBack();
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread);
  await page.waitForSelector(".turn");
  // Settings reloaded, then another section: closing still returns to the thread.
  await page.keyboard.press("ControlOrMeta+,");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  await page.reload();
  await page.click(".settings-nav-item >> text=Plugins");
  await page.waitForFunction(() => location.pathname === "/settings/plugins");
  await page.keyboard.press("Escape");
  await page
    .waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 })
    .catch(async () => assert.fail(`closing settings after a reload went to ${await where()}`));
  // An archived thread opened from settings: settings close and the thread opens, rather than the close undoing the open.
  const archive = (archived: boolean) =>
    page.evaluate(
      async ({ id, archived }) => {
        const { Threads } = await import("/src/ui/contracts.ts" as string);
        await (await (window as any).lemma.service(Threads)).mark(id, { archived });
      },
      { id: seeded, archived },
    );
  await archive(true);
  // Opened from a new thread, so where each step lands is unambiguous.
  await page.evaluate(async () => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await page.waitForFunction(() => location.pathname === "/");
  await page.evaluate(async () => {
    const { Settings } = await import("/src/ui/contracts.ts" as string);
    (await (window as any).lemma.service(Settings)).open("archived");
  });
  await page.waitForFunction(() => location.pathname === "/settings/archived");
  await page.click(
    `.archived-row:has-text("${await page.evaluate(async (id) => {
      const { Threads } = await import("/src/ui/contracts.ts" as string);
      const { sessionTitle } = await import("/src/model/threads.ts" as string);
      return sessionTitle((await (window as any).lemma.service(Threads)).list().find((session: any) => session.id === id));
    }, seeded)}") .archived-title`,
  );
  // Closing settings goes back, which lands later; the thread's own navigation waits for it, in every engine (unheld,
  // Chromium and WebKit apply the back after it and end on "/", and Firefox keeps settings behind the thread).
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, `/threads/${seeded}`, "opening an archived thread did not end on it");
  await page.goBack();
  await page
    .waitForFunction(() => location.pathname === "/", undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`back from an archived thread went to ${await where()}, not where settings were opened from`));
  await page.goForward();
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, seeded);
  await archive(false);
  await page.waitForSelector(".turn");
  // The thread page's plugin off: the address stays and says so; back on, the thread returns.
  await switchTo("thread-view", false);
  await page.waitForSelector(".page-missing >> text=This page is off");
  assert.equal(await where(), thread, "turning the page's plugin off moved the address");
  await switchTo("thread-view", true);
  await page.waitForSelector(".turn");
  // An address from before threads had paths becomes the thread's own; one no page has says so.
  const id = thread.split("/")[2]!.split("?")[0]!;
  await page.goto(`${url}/?mock#${id}`);
  await page
    .waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 10_000 })
    .catch(async () => assert.fail(`/#${id} went to ${await where()}`));
  // The open thread deleted while settings show over it: settings stay.
  await page.evaluate(async () => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await page.fill("textarea", "doomed");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname.startsWith("/threads/"));
  // Its prompt settled, so its draft is gone (a prompt still sending keeps it, and leaving the page would ask).
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  const doomed = new URL(page.url()).pathname.split("/")[2]!;
  await page.keyboard.press("ControlOrMeta+,");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  await page.evaluate(async (id) => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    await (await (window as any).lemma.service(Threads)).remove(id);
  }, doomed);
  await page.waitForTimeout(200);
  assert.match(new URL(page.url()).pathname, /^\/settings/, "deleting the thread under settings closed them");
  // Closing them returns to the deleted thread's address, which leaves for a new thread.
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => location.pathname === "/", undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`closing settings over a deleted thread went to ${await where()}`));
  // Resting on a thread's row fetches its log; opening it uses that rather than fetching again.
  await page.evaluate(async () => {
    const { Client } = await import("/src/ui/contracts.ts" as string);
    const session = (await (window as any).lemma.service(Client)).host.session;
    const events = session.events.bind(session);
    const fetched: unknown[] = ((window as any).fetched = []);
    session.events = (id: string, after?: number) => (fetched.push([id, after ?? null]), events(id, after));
  });
  const row = page.locator(`.session-open[href^="/threads/${seeded}"]`);
  await row.hover();
  await page
    .waitForFunction((id) => (window as any).fetched.some(([fetched, after]: any) => fetched === id && after === null), seeded, { timeout: 2_000 })
    .catch(() => assert.fail("resting on a thread's row did not preload it"));
  await row.click();
  await page.waitForSelector(".turn");
  assert.equal(
    await page.evaluate((id) => (window as any).fetched.filter(([fetched, after]: any) => fetched === id && after === null).length, seeded),
    1,
    "opening a preloaded thread fetched its log again",
  );
  // Unsent text: closing or reloading the tab asks first, while settings show too; sent or cleared, it does not.
  const unloadAsks = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    });
  const settings = (section: string | undefined) =>
    page.evaluate(async (section) => {
      const { Settings } = await import("/src/ui/contracts.ts" as string);
      (await (window as any).lemma.service(Settings)).open(section);
    }, section);
  await page.fill("textarea", "half a thought");
  assert.equal(await unloadAsks(), true, "unsent text did not make leaving the page ask");
  // An attached image stays with the prompt while settings show in the composer's place.
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  await page.setInputFiles('.composer input[type="file"]', { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  await page.waitForSelector(".attachment");
  await settings("general");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  assert.equal(await unloadAsks(), true, "unsent text did not make leaving the page ask while settings show");
  await settings(undefined);
  await page.waitForSelector(".attachment", { timeout: 5_000 }).catch(() => assert.fail("closing settings lost the attached image"));
  assert.equal(await page.inputValue("textarea"), "half a thought", "closing settings lost the unsent text");
  await page.click(".attachment-remove");
  await page.fill("textarea", "");
  assert.equal(await unloadAsks(), false, "an empty composer made leaving the page ask");
  await page.goto(`${url}/nowhere?mock`);
  await page.waitForSelector(".page-missing >> text=No page here");
  // A plugin's own route and page, reached by an ordinary link without reloading.
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/ui/api.ts" as string);
    const { Pages, Router, SidebarFooter } = api.contracts;
    const lemma = (window as any).lemma;
    const router = await lemma.service(Router);
    const Note = api.defineRoute("check.note", { path: "/notes/:id" });
    const page = () => {
      const element = document.createElement("div");
      element.className = "check-page";
      element.textContent = `note ${router.matchOf(Note)?.params.id}`;
      return element;
    };
    const link = () => {
      const element = document.createElement("a");
      element.className = "check-link";
      element.href = router.href(Note, { id: "7" });
      element.textContent = "note";
      return element;
    };
    (window as any).removals = [
      lemma.slots().add(Pages, { id: "check.note", route: Note, component: page }),
      lemma.slots().add(SidebarFooter, { id: "check.link", order: 1_000, component: link }),
    ];
    (window as any).stayed = true;
  });
  await page.click(".check-link");
  await page.waitForSelector(".check-page >> text=note 7");
  assert.equal(await where(), "/notes/7?mock=", "the link did not keep ?mock");
  assert.equal(await page.evaluate(() => (window as any).stayed), true, "following the link reloaded the page");
  await page.evaluate(() => {
    for (const remove of (window as any).removals) remove();
  });
  await page.waitForSelector(".page-missing >> text=No page here");
  expectNoErrors("navigating");
  // A page that throws fails alone and says so; a route matching another's addresses is reported; reading one route's
  // match runs again only when that route's match changes.
  await page.evaluate(async () => {
    const { api } = await import("/src/ui/api.ts" as string);
    const { Pages, Router } = api.contracts;
    const lemma = (window as any).lemma;
    const router = await lemma.service(Router);
    const Broken = api.defineRoute("check.broken", { path: "/broken/:id" });
    const Twin = api.defineRoute("check.twin", { path: "/broken/:key" });
    const check = window as any;
    check.reruns = 0;
    api.solid.createRoot((dispose: () => void) => {
      check.disposeCount = dispose;
      api.solid.createEffect(() => {
        router.matchOf(Broken);
        check.reruns++;
      });
    });
    check.removals = [
      lemma.slots().add(Pages, {
        id: "check.broken",
        route: Broken,
        component: () => {
          throw new Error("check boom");
        },
      }),
      lemma.slots().add(Pages, { id: "check.twin", route: Twin, component: () => document.createElement("div") }),
    ];
    router.navigate(Broken, { id: "1" });
  });
  await page.waitForSelector(".page-missing >> text=This page failed");
  await page.waitForSelector(".page-missing >> text=check boom");
  await page.waitForSelector(".toast >> text=match the same addresses");
  assert(await page.locator(".sidebar").isVisible(), "a failing page took the sidebar with it");
  const reruns = async (navigate: string) =>
    page.evaluate(async (target) => {
      history.pushState(null, "", target);
      dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((done) => setTimeout(done, 50));
      return (window as any).reruns;
    }, navigate);
  assert.equal(await reruns("/broken/2?mock"), 3, "the route's own change did not rerun its reader");
  assert.equal(await reruns("/nowhere?mock"), 4, "leaving the route did not rerun its reader");
  assert.equal(await reruns("/elsewhere?mock"), 4, "an unrelated navigation reran a route's reader");
  await page.evaluate(() => {
    const check = window as any;
    check.disposeCount();
    for (const remove of check.removals) remove();
  });
  errors.splice(0);

  // 8. The devtools: docked under the app, each panel shows the app as it runs, and every panel's data reads as JSON.
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.evaluate(async () => {
    const { Settings } = await import("/src/ui/contracts.ts" as string);
    (await (window as any).lemma.service(Settings)).open(undefined);
  });
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await page.waitForSelector(".devtools");
  const appHeight = () => page.evaluate(() => document.querySelector(".app")!.getBoundingClientRect().height);
  // On every page, and across a reload: what covers the app (settings) leaves what is docked under it in view.
  const dockOnTop = () =>
    page.evaluate(() => {
      const tab = document.querySelector(".devtools [role=tab]")?.getBoundingClientRect();
      return tab !== undefined && document.elementFromPoint(tab.x + tab.width / 2, tab.y + tab.height / 2)?.closest(".devtools") !== null;
    });
  const firstThread: string = await page.evaluate(async () => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    return (await (window as any).lemma.service(Threads)).list()[0].id;
  });
  const sections = ["general", "appearance", "keyboard", "providers", "plugins", "projects", "archived"].map((section) => `/settings/${section}`);
  for (const path of ["/", `/threads/${firstThread}`, `/threads/${firstThread}/trajectory`, ...sections, "/nowhere"]) {
    await page.evaluate(async (path) => {
      const { Router } = await import("/src/ui/contracts.ts" as string);
      (await (window as any).lemma.service(Router)).navigate(path);
    }, path);
    await page.waitForFunction((path) => location.pathname === path, path);
    await page.waitForTimeout(100);
    assert(await dockOnTop(), `the devtools are hidden at ${path}`);
  }
  await page.reload();
  await page.waitForSelector(".devtools", { timeout: 10_000 }).catch(() => assert.fail("a reload closed the devtools"));
  assert(await dockOnTop(), "the devtools are hidden after a reload");
  // The walk ended at an address nothing shows; back to a new thread.
  await page.evaluate(async () => {
    const { Router } = await import("/src/ui/contracts.ts" as string);
    (await (window as any).lemma.service(Router)).navigate("/");
  });
  await page.waitForFunction(() => location.pathname === "/");
  assert((await appHeight()) < 900 - 100, "the app did not make room for the devtools");
  // Routes: why an address shows what it does, and who shows each route.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Routes");
  await page.fill("[aria-label='Address to explain']", "/threads/anything/trajectory");
  await page.waitForSelector("[aria-label=Routes] tr:has(td:text-is('thread')):has-text('shown')");
  await page.waitForSelector("[aria-label=Routes] tr:has(td:text-is('settings')):has-text('no-match')");
  await page.waitForSelector("[aria-label='Route details'] >> text=the most specific fit");
  await page.waitForSelector("[aria-label=Routes] tr:has-text('/threads/:id/:view?') >> text=thread-view");
  // Navigation: the journal has what the router did.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Navigation");
  await page.waitForSelector("[aria-label='Router journal'] >> text=matched");
  // Host events: the host's stream, and a session's id goes to its thread's trajectory.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Host events");
  await page.waitForSelector("[aria-label=Events] tbody tr[data-row]");
  // Pinning a thread has the host publish its change, naming the session.
  const pinned: string = await page.evaluate(async () => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    const threads = await (window as any).lemma.service(Threads);
    const id = threads.list()[0].id;
    await threads.mark(id, { pinned: true });
    await threads.mark(id, { pinned: false });
    return id;
  });
  await page.click(`[aria-label=Events] a >> text=${pinned}`);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}/trajectory`, pinned);
  await page.waitForSelector(".devtools");
  // A plugin's name anywhere opens it in the Plugins panel: everything it does, and what depends on it.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Routes");
  await page.click("[aria-label=Routes] tr:has(td:text-is('/threads/:id/:view?')) button:text-is('thread-view')");
  await page.waitForSelector("[aria-label='Plugin details'] .dt-details-title >> text=thread-view");
  await page.waitForSelector("[aria-label='Plugin details'] tr:has(td:text-is('pages')):has(td:text-is('thread-view.new'))");
  await page.fill("[aria-label='Filter plugins']", "router");
  await page.click("[aria-label=Plugins] tr:has(td:first-child:text-is('router'))");
  await page.waitForSelector("[aria-label='Plugin details'] tr:has(td:text-is('lemma-ui/Router')) >> button:text-is('threads')");
  // The host's plugins too, and each hook's chain in run order.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Hooks");
  await page.click("[aria-label=Hooks] tr:has(td:text-is('lemma/agent.request'))");
  // Equal orders run by plugin id: agent, then compaction, then project-context at order 10.
  for (const [position, id] of ["agent", "compaction", "project-context"].entries()) {
    await page.waitForSelector(`[aria-label='Hook details'] tr:has(td:text-is('${position + 1}')) >> button:text-is('${id}')`);
  }
  // Registries: the web app's slots, live, with who fills each and how to add to it.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Registries");
  await page.fill("[aria-label='Filter registries']", "pages");
  await page.click("[aria-label=Registries] tr:has(td:first-child:text-is('pages'))");
  await page.waitForSelector("[aria-label='Registry items'] tr:has(td:text-is('thread-view.new')):has(button:text-is('thread-view'))");
  // Inspectors: what host plugins let you look into, as tables.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Inspectors");
  await page.click("[aria-label=Inspectors] tr:has-text('Tools')");
  await page.waitForSelector("[aria-label='Inspector snapshot'] td:text-is('bash')");
  const snapshot = await page.evaluate(async () => {
    const { Devtools } = await import("/src/ui/contracts.ts" as string);
    return JSON.parse(JSON.stringify((await (window as any).lemma.service(Devtools)).snapshot()));
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "devtools.events",
    "devtools.hooks",
    "devtools.inspectors",
    "devtools.navigation",
    "devtools.plugins",
    "devtools.registries",
    "devtools.routes",
  ]);
  assert(
    snapshot["devtools.routes"].routes.some((route: any) => route.id === "thread" && route.entries[0] === "thread-view"),
    "the routes snapshot does not say who shows a thread",
  );
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await page.waitForSelector(".devtools", { state: "detached" });
  assert.equal(await appHeight(), 900, "the app did not take its room back when the devtools closed");
  expectNoErrors("using the devtools");

  // 9. While a turn runs: Enter steers it, Alt+Enter queues a prompt for after it, and a queued one can be withdrawn.
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.evaluate(async () => {
    const { Settings } = await import("/src/ui/contracts.ts" as string);
    (await (window as any).lemma.service(Settings)).open(undefined);
  });
  await page.fill("textarea", "start a turn");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".send.stop");
  await page.fill("textarea", "steer it");
  await page.keyboard.press("Enter");
  await page
    .waitForSelector(".queued:has-text('steer it') .queued-mode >> text=Steer", { timeout: 5_000 })
    .catch(() => assert.fail("a steer sent while a turn runs is not shown queued"));
  assert.equal(await page.inputValue("textarea"), "", "a steer that was taken stayed in the composer");
  await page.fill("textarea", "for later");
  await page.keyboard.press("Alt+Enter");
  await page.waitForSelector(".queued:has-text('for later') .queued-mode >> text=Next");
  // The row is a part: a plugin's own replaces it, and the default returns when that goes.
  await page.evaluate(async () => {
    const { ComposerQueuedPart } = await import("/src/ui/contracts.ts" as string);
    (window as any).removeRow = (window as any).lemma.slots().add(ComposerQueuedPart, {
      id: "check.queued",
      order: 0,
      component: (props: { prompt: { requestId: string } }) => {
        const element = document.createElement("li");
        element.className = "check-queued";
        element.textContent = props.prompt.requestId;
        return element;
      },
    });
  });
  await page
    .waitForSelector(".composer-queue .check-queued", { timeout: 5_000 })
    .catch(() => assert.fail("a plugin's composer.queued part does not render the queue"));
  await page.evaluate(() => (window as any).removeRow());
  await page.click(".queued:has-text('for later') .queued-remove");
  await page.waitForSelector(".queued:has-text('for later')", { state: "detached" });
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  await page.waitForSelector(".queued", { state: "detached" });
  // One turn, holding both prompts: the steer where it joined.
  assert.deepEqual(
    await page.locator(".turn").evaluateAll((turns) => turns.map((turn) => [...turn.querySelectorAll(".user-text")].map((user) => user.textContent))),
    [["start a turn", "steer it"]],
    "the steer is not shown in the turn it joined",
  );
  expectNoErrors("steering and queueing");

  // A send that fails (the connection dropped, say) keeps its request id: sending the same prompt again, even after
  // moving to another thread and back, is a retry the host can recognise. An edit makes it a new prompt.
  await page.evaluate(async () => {
    const { Client } = await import("/src/ui/contracts.ts" as string);
    const agent = (await (window as any).lemma.service(Client)).host.agent;
    const prompt = agent.prompt.bind(agent);
    const sent: (string | undefined)[] = ((window as any).sentIds = []);
    agent.prompt = (sessionId: string, content: unknown, options: unknown, submit?: { requestId?: string }) => {
      sent.push(submit?.requestId);
      return sent.length === 1 || sent.length === 3 ? Promise.reject(new Error("connection lost")) : prompt(sessionId, content, options, submit);
    };
  });
  const sentIds = () => page.evaluate(() => (window as any).sentIds as (string | undefined)[]);
  await page.evaluate(async () => {
    const { Threads } = await import("/src/ui/contracts.ts" as string);
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await page.waitForFunction(() => location.pathname === "/");
  await page.fill("textarea", "retry me");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).sentIds.length === 1);
  // The send created its thread and moved there; the refused prompt is back in the composer.
  await page.waitForFunction(
    () => location.pathname.startsWith("/threads/") && (document.querySelector("textarea") as HTMLTextAreaElement).value === "retry me",
  );
  const retrying = new URL(page.url()).pathname;
  await page.goBack();
  await page.waitForFunction((path) => location.pathname !== path, retrying);
  await page.goForward();
  await page.waitForFunction(
    (path) => location.pathname === path && (document.querySelector("textarea") as HTMLTextAreaElement).value === "retry me",
    retrying,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).sentIds.length === 2);
  const [first, retried] = await sentIds();
  assert(first !== undefined && first === retried, `a retried send had another request id: ${first} then ${retried}`);
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  // Fails again, and the person changes the prompt before sending it: a new prompt, with a new id.
  await page.fill("textarea", "edit me");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).sentIds.length === 3);
  await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement).value === "edit me");
  await page.fill("textarea", "edit me, edited");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).sentIds.length === 4);
  const [, , refused, edited] = await sentIds();
  assert(refused !== undefined && edited !== undefined && refused !== edited, "an edited prompt was sent with the failed one's request id");
  // The failed sends were reported; nothing else went wrong.
  errors.splice(0);

  // 10. The prompt rail: a tick per prompt; the card for the one pointed at is level with it, and a click goes there.
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.evaluate(async () => {
    const { Settings } = await import("/src/ui/contracts.ts" as string);
    (await (window as any).lemma.service(Settings)).open(undefined);
  });
  for (const [index, prompt] of ["first prompt", "second prompt", "third prompt"].entries()) {
    await page.fill("textarea", prompt);
    await page.keyboard.press("Enter");
    await page.waitForFunction((count) => document.querySelectorAll(".turn-footer").length === count, index + 1, { timeout: 20_000 });
  }
  const ticks = page.locator("nav[aria-label='Prompts'] button.prompt-tick");
  assert.equal(await ticks.count(), 3, "the prompts landmark does not have a tick button per prompt");
  // The strip is level with the middle of the whole pane, the composer included, not just the chat above it.
  const railPlace = () =>
    page.evaluate(() => {
      const strip = document.querySelector(".prompt-strip")!.getBoundingClientRect();
      const head = document.querySelector(".main-head")!.getBoundingClientRect();
      const main = document.querySelector(".main")!.getBoundingClientRect();
      return {
        offCenter: Math.abs(strip.top + strip.height / 2 - (head.bottom + main.bottom) / 2),
        stepsOut:
          document.querySelector(".prompt-step.next")!.getBoundingClientRect().bottom - document.querySelector(".chat-view")!.getBoundingClientRect().bottom,
      };
    });
  assert.ok((await railPlace()).offCenter <= 1, "the prompt rail is not level with the middle of the pane");
  // With a composer too tall for that, it stops while its steps still fit in the chat view.
  await page.fill("textarea", Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n"));
  await page.waitForTimeout(200);
  assert.ok((await railPlace()).stepsOut <= 0, "a tall composer pushes the prompt rail's steps out of the chat view");
  await page.fill("textarea", "");
  assert.deepEqual(
    await ticks.evaluateAll((all) => all.map((tick) => [tick.tabIndex, tick.getAttribute("aria-current")])),
    [
      [-1, null],
      [-1, null],
      [0, "location"],
    ],
    "the current prompt's tick is not the rail's one tab stop",
  );
  const point = async (index: number) => {
    const box = (await ticks.nth(index).boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
  };
  const cardShows = (text: string, failure: string) =>
    page.waitForSelector(`.prompt-card:has-text('${text}')`, { timeout: 5_000 }).catch(() => assert.fail(failure));
  /** The scroller's position once a smooth scroll stops. */
  const scrolled = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const scroller = document.querySelector(".chat-view .scroller")!;
          let last = -1;
          let still = 0;
          const frame = () => {
            still = scroller.scrollTop === last ? still + 1 : 0;
            last = scroller.scrollTop;
            if (still >= 10) resolve(last);
            else requestAnimationFrame(frame);
          };
          frame();
        }),
    );
  await point(1);
  await cardShows("second prompt", "pointing at a tick does not show its prompt");
  const [tick, card] = await page.evaluate(() =>
    [".prompt-tick.pointed", ".prompt-card"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return (box.top + box.bottom) / 2;
    }),
  );
  assert(Math.abs(tick! - card!) < 1, `the prompt card's middle is at ${card}, not level with its tick at ${tick}`);
  // From the bottom, the previous and next buttons (reached from the strip) move the view a turn each time.
  const step = async (which: "previous" | "next") => {
    const strip = (await page.locator(".prompt-hit").boundingBox())!;
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
    const button = (await page.locator(`.prompt-step.${which}`).boundingBox())!;
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    return scrolled();
  };
  const bottom = await scrolled();
  const up = await step("previous");
  const further = await step("previous");
  const down = await step("next");
  assert(up < bottom - 10 && further < up - 10 && down > further + 10, `stepping through prompts went ${bottom} → ${up} → ${further} → ${down}`);
  await point(0);
  await page.mouse.down();
  await page.mouse.up();
  const atFirst = await scrolled();
  const [turnTop, ...lit] = await page.evaluate(() => [
    document.querySelector<HTMLElement>(".turn")!.offsetTop,
    ...[...document.querySelectorAll(".prompt-tick")].map((element) => element.classList.contains("seen")),
  ]);
  assert(
    Math.abs(atFirst - (Number(turnTop) - 8)) < 2 && lit[0] === true && lit[2] === false,
    `clicking the first prompt's tick went to ${atFirst} (its turn is at ${turnTop}), lighting ${lit}`,
  );
  // The keys move along the ticks; pointing elsewhere and away gives the card back to the focused one, and Enter goes there.
  await page.mouse.move(900, 450);
  await page.focus(".prompt-tick[tabindex='0']");
  await page.keyboard.press("End");
  await cardShows("third prompt", "the keys do not choose a prompt on the rail");
  // A key with a modifier is left to the app's shortcuts.
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Prompt 3 of 3: third prompt", "the rail took a modified key");
  await point(0);
  await cardShows("first prompt", "pointing at a tick while another is focused does not show it");
  await page.mouse.move(900, 450);
  await cardShows("third prompt", "the focused tick's card did not return when the pointer left");
  await page.keyboard.press("Enter");
  assert((await scrolled()) > atFirst + 10, "Enter on a focused tick does not go to its prompt");
  // With short last turns (their replies hidden), the view cannot reach their starts: Previous still goes up from the bottom.
  await page.addStyleTag({ content: ".turn:nth-of-type(n + 2) > :not(:first-child) { display: none }" });
  await page.evaluate(() => {
    const scroller = document.querySelector(".chat-view .scroller")!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  const end = await scrolled();
  const back = await step("previous");
  const forth = await step("next");
  assert(back < end - 10 && forth > back + 10, `stepping past short turns went ${end} → ${back} → ${forth}`);
  // The width setting moves the text without resizing the window: the strip moves aside and stays clear of it.
  await page.evaluate(() => document.documentElement.style.setProperty("--content", "none"));
  await page
    .waitForFunction(
      () => {
        const content = document.querySelector(".chat-view .content")!;
        const text = content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft);
        return document.querySelector(".prompt-hit")!.getBoundingClientRect().right <= text - 8 && document.querySelector(".prompt-rail.tucked") !== null;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("the prompt rail's strip covers the text once the content is wider"));
  await page.evaluate(() => document.documentElement.style.removeProperty("--content"));
  expectNoErrors("using the prompt rail");

  // 11. No provider set up: the chat, not settings, and its notice opens Providers, which returns to the chat once one connects.
  const fresh = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto(`${url}/?mock`);
  await fresh.waitForSelector(".composer-callout, .settings");
  assert.equal(await fresh.locator(".settings").count(), 0, "with no provider set up, the app opened settings rather than the chat");
  await fresh.click(".composer-callout >> text=Log in to a provider");
  await fresh.waitForSelector(".settings >> text=Connect a provider to start chatting");
  await fresh.locator(".provider", { hasText: "Mistral" }).locator(".provider-connect").click();
  await fresh.fill(".provider-key input", "sk-check");
  await fresh.press(".provider-key input", "Enter");
  await fresh.waitForSelector(".settings", { state: "detached", timeout: 5_000 }).catch(() => assert.fail("connecting the first provider left settings open"));
  await fresh.waitForSelector("textarea");
  assert.equal(await fresh.locator(".composer-callout").count(), 0, "the no-provider notice stayed after connecting one");
  const connection = fresh.locator(".sidebar-foot .connection");
  assert.ok((await connection.boundingBox())!.width < 30, "the footer connection should be a dot, not text");
  assert.equal((await connection.textContent())?.trim(), "Connected", "the dot's live region must carry its status as text, which is announced");
  // Reload is its own plugin: an action (listed in the palette, keys bindable) that its footer button, right of the dot, runs.
  assert.ok(
    await fresh.evaluate(async () => {
      const { Actions } = await import("/src/ui/contracts.ts" as string);
      return (window as any).lemma.slots().get(Actions, "reload.app") !== undefined;
    }),
    "reload is not an action",
  );
  const [dot, reloadButton] = await Promise.all([connection.boundingBox(), fresh.getByRole("button", { name: "Reload Lemma", exact: true }).boundingBox()]);
  assert.ok(dot!.x < reloadButton!.x, "the connection's dot should sit left of the reload button");
  await Promise.all([fresh.waitForEvent("load"), fresh.getByRole("button", { name: "Reload Lemma", exact: true }).click()]);
  await fresh.waitForSelector(".sidebar-foot .connection-connected");
  // What the host's reload changed is reported on the page it reloads to.
  await fresh
    .getByText(/^Reloaded: /)
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("a reload did not report what it changed"));
  await fresh.close();
  expectNoErrors("connecting a first provider and reloading the UI");

  console.log(
    `UI check: booted; every part provided; ${toggled.length - locked.length} plugins turned off and on, ${locked.length} locked ones kept on (${locked.join(", ")}); a part replaced and restored; six extension slots render what a plugin adds; @ completes files and a plugin adds completions; addresses survive reloads, back, and their page's plugin going off; a plugin adds a page; the devtools show routes, navigation, host events, plugins, hooks, registries, and inspectors; a running turn takes steers and queued prompts; a failed send is retried with its request id; the prompt rail previews a prompt level with its tick and goes to it; with no provider it opens in the chat, whose notice leads to Providers and back.`,
  );
} finally {
  await browser.close();
  await server.close();
}
