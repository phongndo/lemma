import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { atBlankThread, boot, checkPlugin, expose, settled, switchTo, url } from "./shared.ts";

// 7: the address names what shows; a page whose plugin is off says so; a plugin adds a page; leaving the page asks only for what would be lost.
export const addresses = async (): Promise<string> => {
  const { page, errors, expectNoErrors } = await boot(await startHost());
  // A thread made here, and over it the Plugins page, a plugin selected.
  await page.fill("textarea", "hello");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  await page.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open("plugins");
  });
  await page.click(".inspector-table [role=rowgroup][aria-label='agent'] .inspector-domain");
  await page.click(".inspector-row[data-key='host:agent.loop']");
  await page.waitForSelector(".inspector-table [aria-selected=true] >> text=agent.loop", { timeout: 5_000 });

  // 7. The address names what shows: a settings section and its state, a thread and its view. Reloads, back and forward,
  // and links return to them; a page whose plugin is off says so and comes back with it; a plugin adds a page of its own.
  const where = () => page.evaluate(() => `${location.pathname}${location.search}`);
  const selected = await page.evaluate(() => {
    const row = document.querySelector(".inspector-table [aria-selected=true] .plugin-id");
    return row?.textContent ?? undefined;
  });
  assert(selected !== undefined, "no plugin is selected on the Plugins page");
  assert.match(await where(), new RegExp(`^/settings/plugins\\?(.*&)?plugin=${selected}(&|$)`), "the selected plugin is not in the address");
  await page.reload();
  await page
    .waitForSelector(`.inspector-table [aria-selected=true] >> text=${selected}`, { timeout: 10_000 })
    .catch(() => assert.fail("a reload loses the selected plugin"));
  // Closing settings returns to the thread they were opened over.
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => location.pathname.startsWith("/threads/"), undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`closing settings went to ${await where()}`));
  // A seeded thread, the newest besides the one made here, opened from its row.
  const created = (await where()).split("/")[2]!.split("?")[0]!;
  const seeded: string = await page.evaluate(async (created) => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const threads = await (window as any).lemma.service(Threads);
    return threads.list().find((session: any) => session.id !== created && session.lastSeq > 0 && session.archived !== true).id;
  }, created);
  await page.click(`.thread-open[href="/threads/${seeded}"]`);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, seeded);
  const thread = await where();
  await page.reload();
  await page.waitForSelector(".turn", { timeout: 10_000 }).catch(() => assert.fail("a reload does not reopen the thread"));
  // A tool view with a summary and no body retitles its calls and leaves the body to the chat's own.
  await checkPlugin(page);
  await page.evaluate(async () => {
    const { ToolViews } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (window as any).removeToolView = (window as any).checkSlots.add(ToolViews, { id: "bash", summary: () => ({ primary: "summarized by a plugin" }) });
  });
  if ((await page.locator(".work-head[aria-expanded=false]").count()) > 0) await page.click(".work-head[aria-expanded=false] >> nth=0");
  // Calls made one after another sit in a group of the fold.
  if ((await page.locator(".work-group-head[aria-expanded=false]").count()) > 0) await page.click(".work-group-head[aria-expanded=false] >> nth=0");
  await page.click(".tool-head:has-text('summarized by a plugin') >> nth=0");
  await page.waitForSelector(".tool-body", { timeout: 5_000 }).catch(() => assert.fail("a tool view without a body hid the chat's own"));
  await page.evaluate(() => (window as any).removeToolView());
  // A saved position out of reach (the window grew) ends at the nearest, and scrolling is remembered again after.
  await page.evaluate(async () => {
    const { Router } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Router)).entry("chat.scroll").set(1_000_000);
  });
  await page.reload();
  await page.waitForSelector(".turn");
  await expose(page, "Router");
  // The seeded thread may not scroll at all, so the reader's scroll is an event, not a move: one each frame until the
  // chat, done placing the saved position, remembers one.
  await page
    .waitForFunction(
      () => {
        document.querySelector(".chat-view .scroller")!.dispatchEvent(new Event("scroll"));
        return (window as any).services.Router.entry("chat.scroll").get() !== 1_000_000;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("an unreachable saved position kept the chat from remembering scrolls"));
  // The thread page's plugin off: the address stays and says so, naming the plugin that declares the route; back on,
  // the thread returns.
  await switchTo(page, "threads.view", false);
  await page.waitForSelector(".page-missing >> text=This page is off");
  await page.waitForSelector(".page-missing >> text=The “threads.view” plugin shows these pages");
  assert.match(
    (await page.getAttribute(".page-missing a:text-is('Plugins')", "href")) ?? "",
    /[?&]plugin=threads\.view(&|$)/,
    "the off page's Plugins link does not open threads.view",
  );
  assert.equal(await where(), thread, "turning the page's plugin off moved the address");
  await switchTo(page, "threads.view", true);
  await page.waitForSelector(".turn");
  // An address from before threads had paths becomes the thread's own; one no page has says so.
  const id = thread.split("/")[2]!.split("?")[0]!;
  await page.goto(`${url}/#${id}`);
  await page
    .waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 10_000 })
    .catch(async () => assert.fail(`/#${id} went to ${await where()}`));
  // The address changes while the plugins start, before the page is up.
  await settled(page);
  // The open thread deleted while settings show over it: settings stay.
  await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await atBlankThread(page);
  await page.fill("textarea", "doomed");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname.startsWith("/threads/"));
  // Its prompt settled, so its draft is gone (a prompt still sending keeps it, and leaving the page would ask).
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  const doomed = new URL(page.url()).pathname.split("/")[2]!;
  await page.keyboard.press("ControlOrMeta+,");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  await expose(page, "Router", "Threads");
  await page.evaluate(async (id) => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    await (await (window as any).lemma.service(Threads)).remove(id);
  }, doomed);
  // Once the app has it gone, and any move that set off has landed, settings are still there.
  await page.waitForFunction(
    (id) => {
      const { Router, Threads } = (window as any).services;
      return !Threads.list().some((session: any) => session.id === id) && !Router.inspect().moving;
    },
    doomed,
    { timeout: 5_000 },
  );
  assert.match(new URL(page.url()).pathname, /^\/settings/, "deleting the thread under settings closed them");
  // Closing them returns to the deleted thread's address, which leaves for the new-thread page, and that for a blank
  // thread.
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(
      (id) => {
        const shown = (window as any).services.Threads.active();
        return location.pathname !== `/threads/${id}` && shown !== undefined && shown.lastSeq === 0;
      },
      doomed,
      { timeout: 5_000 },
    )
    .catch(async () => assert.fail(`closing settings over a deleted thread went to ${await where()}`));
  // Resting on a thread's row fetches its log; opening it follows the log on from there rather than reading it again.
  await page.evaluate(async () => {
    const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const channel = (await (window as any).lemma.service(Client)).channel;
    const { call, open } = channel;
    const fetched: unknown[] = ((window as any).fetched = []);
    const idOf = (target: string | { id: string }) => (typeof target === "string" ? target : target.id);
    channel.call = (target: string | { id: string }, payload?: any) => {
      if (idOf(target) === "sessions.events") fetched.push(["events", payload.sessionId, payload.after ?? 0]);
      return call(target, payload);
    };
    channel.open = (target: string | { id: string }, payload: any, ...rest: unknown[]) => {
      if (idOf(target) === "sessions.log") fetched.push(["log", payload.sessionId, payload.after ?? 0]);
      return open(target, payload, ...rest);
    };
  });
  const reads = (id: string) => page.evaluate((id) => (window as any).fetched.filter(([, session]: any) => session === id), id);
  const row = page.locator(`.thread-open[href="/threads/${seeded}"]`);
  await row.hover();
  await page
    .waitForFunction((id) => (window as any).fetched.some(([kind, session]: any) => kind === "events" && session === id), seeded, { timeout: 2_000 })
    .catch(() => assert.fail("resting on a thread's row did not preload it"));
  await row.click();
  await page.waitForSelector(".turn");
  await page.waitForFunction((id) => (window as any).fetched.some(([kind, session]: any) => kind === "log" && session === id), seeded);
  const [preloaded, followed, ...more] = await reads(seeded);
  assert.deepEqual([preloaded[0], followed[0], more], ["events", "log", []], "opening a preloaded thread read its log again");
  assert(followed[2] > 0, "opening a preloaded thread followed its log from the start rather than from what the preload read");
  // Unsent text comes back after a reload (`Threads.drafts`), so closing or reloading the tab does not ask for it; an
  // attached image, which would be lost, makes it ask first, while settings show too; removed, it does not.
  const unloadAsks = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    });
  const settings = (section: string | undefined) =>
    page.evaluate(async (section) => {
      const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
      (await (window as any).lemma.service(Settings)).open(section);
    }, section);
  await page.fill("textarea", "half a thought");
  assert.equal(await unloadAsks(), false, "unsent text, which comes back, made leaving the page ask");
  // An attached image stays with the prompt while settings show in the composer's place.
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  await page.setInputFiles('.composer input[type="file"]', { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  await page.waitForSelector(".attachment");
  assert.equal(await unloadAsks(), true, "an unsent image did not make leaving the page ask");
  await settings("general");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  assert.equal(await unloadAsks(), true, "an unsent image did not make leaving the page ask while settings show");
  await settings(undefined);
  await page.waitForSelector(".attachment", { timeout: 5_000 }).catch(() => assert.fail("closing settings lost the attached image"));
  assert.equal(await page.inputValue("textarea"), "half a thought", "closing settings lost the unsent text");
  await page.click(".attachment-remove");
  assert.equal(await unloadAsks(), false, "a removed image still made leaving the page ask");
  // A file dropped that is no image is not attached, and the composer says so.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    document.querySelector("form.composer")!.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page
    .waitForSelector(".toast >> text=A file was not attached: only images can be.", { timeout: 5_000 })
    .catch(() => assert.fail("a dropped file that is no image was not said to be left out"));
  assert.equal(await page.locator(".attachment").count(), 0, "a dropped file that is no image was attached");
  // So are files pasted.
  await page.evaluate(() => {
    const data = new DataTransfer();
    for (const name of ["a.txt", "b.pdf"]) data.items.add(new File(["x"], name, { type: name.endsWith(".pdf") ? "application/pdf" : "text/plain" }));
    document.querySelector("form.composer textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page
    .waitForSelector(".toast >> text=2 files were not attached: only images can be.", { timeout: 5_000 })
    .catch(() => assert.fail("pasted files that are no images were not said to be left out"));
  await page.fill("textarea", "");
  assert.equal(await unloadAsks(), false, "an empty composer made leaving the page ask");
  await page.goto(`${url}/nowhere`);
  await page.waitForSelector(".page-missing >> text=No page here");
  // A plugin's own route and page, reached by an ordinary link without reloading.
  await page.goto(`${url}/`);
  await settled(page);
  await checkPlugin(page);
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
      (window as any).checkSlots.add(Pages, { id: "check.note", route: Note, component: page }),
      (window as any).checkSlots.add(SidebarFooter, { id: "check.link", order: 1_000, component: link }),
    ];
    (window as any).stayed = true;
  });
  await page.click(".check-link");
  await page.waitForSelector(".check-page >> text=note 7");
  assert.equal(await where(), "/notes/7", "the link did not go to its address");
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
      check.checkSlots.add(Pages, {
        id: "check.broken",
        route: Broken,
        component: () => {
          throw new Error("check boom");
        },
      }),
      check.checkSlots.add(Pages, { id: "check.twin", route: Twin, component: () => document.createElement("div") }),
    ];
    router.navigate(Broken, { id: "1" });
  });
  await page.waitForSelector(".page-missing >> text=This page failed");
  await page.waitForSelector(".page-missing >> text=check boom");
  await page.waitForSelector(".toast >> text=match the same addresses");
  assert(await page.locator(".sidebar .thread-list").isVisible(), "a failing page took the thread list with it");
  // Readers run again as the router takes the address in (all at once): once it has, their count is final.
  await expose(page, "Router");
  const reruns = async (navigate: string) => {
    await page.evaluate((target) => {
      history.pushState(null, "", target);
      dispatchEvent(new PopStateEvent("popstate"));
    }, navigate);
    await page.waitForFunction((path) => (window as any).services.Router.location().pathname === path, new URL(navigate, url).pathname, { timeout: 5_000 });
    return page.evaluate(() => (window as any).reruns);
  };
  assert.equal(await reruns("/broken/2"), 3, "the route's own change did not rerun its reader");
  assert.equal(await reruns("/nowhere"), 4, "leaving the route did not rerun its reader");
  assert.equal(await reruns("/elsewhere"), 4, "an unrelated navigation reran a route's reader");
  await page.evaluate(() => {
    const check = window as any;
    check.disposeCount();
    for (const remove of check.removals) remove();
  });
  // A `Pages` item whose route is not made with defineRoute is its plugin's fault, named for it and reported, and is
  // left out: the runtime's router goes on taking in pages and navigating.
  await page.evaluate(async () => {
    const { Pages } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (window as any).removeMalformed = (window as any).checkSlots.add(Pages, {
      id: "check.no-route",
      route: { id: "check.no-route", path: "/no-route" },
      component: () => document.createElement("div"),
    });
  });
  await page.waitForFunction(async () => {
    const { Pages } = (await import("/src/ui/api.ts" as string)).api.contracts;
    return (window as any).lemma.slots().failures(Pages).length === 1;
  });
  assert.deepEqual(
    await page.evaluate(async () => {
      const { Pages } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (window as any).lemma
        .slots()
        .failures(Pages)
        .map((failure: any) => [failure.item.id, failure.pluginId]);
    }),
    [["check.no-route", "check"]],
    "a page without a route is not named for its plugin",
  );
  await page.waitForSelector('.toast >> text=The "check.no-route" page has no route made with defineRoute');
  await page.evaluate(async () => {
    const { api } = await import("/src/ui/api.ts" as string);
    const { Pages, Router } = api.contracts;
    const After = api.defineRoute("check.after", { path: "/after/:id" });
    const page = () => {
      const element = document.createElement("div");
      element.className = "check-after";
      element.textContent = "after a page without a route";
      return element;
    };
    (window as any).removeAfter = (window as any).checkSlots.add(Pages, { id: "check.after", route: After, component: page });
    (await (window as any).lemma.service(Router)).navigate(After, { id: "1" });
  });
  await page.waitForSelector(".check-after");
  assert.equal(await where(), "/after/1", "the router did not navigate after a page without a route");
  await page.evaluate(() => {
    (window as any).removeAfter();
    (window as any).removeMalformed();
  });
  errors.splice(0);
  // \`?safe\` says how the page runs, not what it shows, so every navigation keeps it: a link names it, and following one
  // keeps it.
  await page.goto(`${url}/?safe`);
  await settled(page);
  const safeRow = page.locator(".thread-open").first();
  await safeRow.waitFor({ timeout: 10_000 });
  assert.match((await safeRow.getAttribute("href")) ?? "", /[?&]safe=/, "a link in a page run safe does not keep ?safe");
  await safeRow.click();
  await page
    .waitForFunction(() => location.pathname.startsWith("/threads/") && new URLSearchParams(location.search).has("safe"), undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`following a link in a page run safe went to ${await where()}`));
  expectNoErrors("following a link in a page run safe");
  return "addresses survive reloads, back, and their page's plugin going off, and keep ?safe; a thread's row preloads it; leaving asks only for what would be lost; a plugin adds a page, one that throws fails alone, and one with no route is its plugin's fault";
};
