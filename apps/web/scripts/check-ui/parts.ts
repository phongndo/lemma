import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { atBlankThread, boot, checkPlugin, expose, root, settled, switchTo, url } from "./shared.ts";

// 4–7: a part replaced, what plugins add to the extension slots, and the address.
export const parts = async (): Promise<string> => {
  const { page, errors, expectNoErrors } = await boot();
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

  // 6. What a plugin adds to the places the defaults use renders there: a marker in each.
  const marker = (slot: string, extra: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ slot, extra }) => {
        const contracts = (await import("/src/ui/api.ts" as string)).api.contracts;
        const component = () => {
          const element = document.createElement("span");
          element.className = `check-marker check-${slot}`;
          element.textContent = slot;
          return element;
        };
        const remove = (window as any).checkSlots.add(contracts[slot], { id: `check.${slot}`, order: 1_000, component, ...extra });
        ((window as any).removals ??= []).push(remove);
      },
      { slot, extra },
    );
  await marker("ThreadHeader", { side: "end" });
  await marker("SidebarActions");
  await marker("ComposerActions");
  await marker("ThreadCard");
  for (const slot of ["ThreadHeader", "SidebarActions", "ComposerActions", "ThreadCard"]) {
    await page.waitForSelector(`.check-${slot}`, { timeout: 5_000 }).catch(() => assert.fail(`${slot} does not render what a plugin adds`));
  }
  // A palette source: its items come up in the palette, and its prefix narrows to it.
  await page.evaluate(async () => {
    const { PaletteSources } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const remove = (window as any).checkSlots.add(PaletteSources, {
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
  // Its key closes it too, as its footer says, though Ctrl+K moves up a list where Ctrl is the modifier.
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForSelector(".palette");
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForSelector(".palette", { state: "detached", timeout: 5_000 }).catch(() => assert.fail("the palette's key did not close it"));
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
    const { ComposerCompletions, ComposerSuggestionPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const slots = (window as any).checkSlots;
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
  // Enter while the answer is on its way waits for it, rather than sending a half-typed mention. The answer is held
  // until Enter is down, so it is still on its way however long the keys took to arrive.
  await page.evaluate(async () => {
    const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const channel = (await (window as any).lemma.service(Client)).channel;
    const call = channel.call;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    channel.call = async (target: string | { id: string }, payload?: unknown) => {
      if ((typeof target === "string" ? target : target.id) === "files.search") await held;
      return call(target, payload);
    };
    (window as any).releaseSearch = () => {
      channel.call = call;
      release();
    };
  });
  await page.fill("textarea", "");
  await page.keyboard.type("@READ");
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("textarea"), "@READ", "Enter sent the prompt while its suggestions loaded");
  await page.evaluate(() => (window as any).releaseSearch());
  await page.waitForSelector(".completion >> text=README.md", { timeout: 5_000 });
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("textarea"), "@README.md ", "Enter does not pick once the suggestions arrive");
  // A folder picked goes on completing inside it, and only inside it.
  await page.keyboard.type("@src");
  // By its label, not its place: the list may still be filling, and a row's index then moves under the click.
  await page
    .locator(".completion", { has: page.locator(".menu-label", { hasText: /^src$/ }) })
    .first()
    .click({ timeout: 5_000 });
  assert.equal(await page.inputValue("textarea"), "@README.md @src/", "picking a folder does not leave it open to type on");
  await page.waitForSelector('.completions [role="listbox"][aria-busy="false"]', { timeout: 5_000 });
  const outside: string[] = await page.evaluate(() =>
    [...document.querySelectorAll(".completion")]
      .map((row) => `${row.querySelector(".menu-hint")?.textContent ?? ""}/${row.querySelector(".menu-label")?.textContent ?? ""}`)
      .filter((path) => !path.startsWith("src/") || path === "src/src"),
  );
  assert.deepEqual(outside, [], "inside a picked folder, the menu offers what is outside it");
  await page.fill("textarea", "");
  // `/` completes a command, then its arguments, across the space: Tab only completes, and Enter on the last runs it.
  // A plugin's command (`PromptCommands`) shows beside the bundled ones; it runs here rather than being sent.
  await page.evaluate(async () => {
    const { PromptCommands } = (await import("/src/ui/api.ts" as string)).api.contracts;
    ((window as any).removals ??= []).push(
      (window as any).checkSlots.add(PromptCommands, {
        id: "checkpick",
        order: 1_000,
        description: "Checks a command's argument",
        args: [{ name: "speed", values: () => [{ value: "slow" }, { value: "high" }] }],
        run: ({ args }: { args: readonly string[] }) => void ((window as any).ranCommand = args.join(" ")),
      }),
    );
  });
  await page.keyboard.type("/");
  // By the whole label: the letters typed are marked, which splits its text.
  const menuRow = (label: string) => page.locator(".completion .menu-label", { hasText: new RegExp(`^${label.replace(/[$/]/g, "\\$&")}$`) }).first();
  for (const name of ["/new", "/compact", "/thinking", "/checkpick"]) {
    await menuRow(name)
      .waitFor({ timeout: 5_000 })
      .catch(() => assert.fail(`the / menu does not offer ${name}`));
  }
  await page.keyboard.type("checkp");
  await menuRow("/checkpick").waitFor({ timeout: 5_000 });
  // The ghost after the cursor: the rest of the active command, and what it takes.
  assert.equal(
    await page.locator(".composer-ghost-text").textContent({ timeout: 5_000 }),
    "ick <speed>",
    "the prompt does not hint at the rest of the command",
  );
  await page.keyboard.press("Tab");
  assert.equal(await page.inputValue("textarea"), "/checkpick ", "Tab does not complete a command's name");
  await menuRow("high")
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("the / menu does not go on to the argument"));
  await page.keyboard.type("hi");
  await page.keyboard.press("Enter");
  await page
    .waitForFunction(() => (window as any).ranCommand === "high", undefined, { timeout: 5_000 })
    .catch(() => assert.fail("Enter on the last argument does not run the command"));
  assert.equal(await page.inputValue("textarea"), "", "a command that ran stays in the prompt");
  // Words a command does not take are refused, not dropped: the prompt stays, and says why.
  await page.evaluate(() => ((window as any).ranCommand = undefined));
  await page.keyboard.type("/checkpick high and more");
  await page.keyboard.press("Enter");
  await page
    .waitForSelector(".toast-text >> text=/checkpick takes <speed>", { timeout: 5_000 })
    .catch(() => assert.fail("a command with words too many does not say so"));
  assert.equal(await page.inputValue("textarea"), "/checkpick high and more", "a command with words too many lost the prompt");
  assert.equal(await page.evaluate(() => (window as any).ranCommand), undefined, "a command with words too many ran");
  await page.fill("textarea", "");
  // A word trigger inside a command line completes as anywhere: `@` past `/compact`.
  await page.keyboard.type("/compact keep @READ");
  await menuRow("README.md")
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("@ does not complete inside a command line"));
  await page.fill("textarea", "");
  // A path at the start of a prompt is no command: past its first word the menu closes.
  await page.keyboard.type("/usr/bin/env node");
  await page
    .waitForSelector(".completions", { state: "detached", timeout: 5_000 })
    .catch(() => assert.fail("the / menu stays open over a prompt that is no command"));
  await page.fill("textarea", "");
  // `$` offers the skills, and a pick writes its name.
  await page.keyboard.type("use $rev");
  await menuRow("review")
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("the $ menu does not offer the skills"));
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("textarea"), "use $review ", "picking a skill does not write its name");
  await page.fill("textarea", "");
  expectNoErrors("completing in the composer");
  // An inspector tab: it lists for the selected plugin. Over a thread with requests, whose latest one the Cost tab reads.
  await page.evaluate(async () => {
    const { PluginTabs, Settings, Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const lemma = (window as any).lemma;
    const threads = await lemma.service(Threads);
    (window as any).threadBefore = threads.activeId();
    await threads.select(threads.list().find((info: { readonly title?: string }) => info.title === "Fix flaky session log test").id);
    const remove = (window as any).checkSlots.add(PluginTabs, {
      id: "check.tab",
      order: 1_000,
      label: () => "Checked",
      component: () => document.createElement("span"),
    });
    ((window as any).removals ??= []).push(remove);
    (await lemma.service(Settings)).open("plugins");
  });
  // A bundled plugin's, in its domain: the check plugin's own row goes with a reload (below).
  await page.click(".inspector-table [role=rowgroup][aria-label='agent'] .inspector-domain");
  await page.click(".inspector-row[data-key='host:agent.loop']");
  await page.waitForSelector(".inspector-tabs >> text=Checked", { timeout: 5_000 }).catch(() => assert.fail("an inspector tab does not show"));
  // A plugin's share of the open thread's latest request: agent.loop put the base prompt there.
  await page.click(".inspector-tabs >> text=Cost");
  await page
    .waitForSelector(".trj-cost td >> text=base", { timeout: 5_000 })
    .catch(() => assert.fail("the Cost tab does not show what a plugin put in the latest request"));
  // Back over the thread it was opened over, as the checks below expect, the page as it was left.
  await page.evaluate(async () => {
    const { Settings, Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const lemma = (window as any).lemma;
    await (await lemma.service(Threads)).select((window as any).threadBefore);
    (await lemma.service(Settings)).open("plugins");
  });
  await page.waitForSelector(".inspector-table [aria-selected=true] >> text=agent.loop", { timeout: 5_000 });
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
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const threads = await (window as any).lemma.service(Threads);
    return threads.list().find((session: any) => session.id !== created && session.lastSeq > 0 && session.archived !== true).id;
  }, created);
  await page.click(`.thread-open[href^="/threads/${seeded}?"]`);
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
  await page.click(".thread-inspector-head [aria-label='Open a view']");
  await page.click(".popover [role=menuitem] >> text=Trace");
  await page.waitForFunction(() => document.querySelectorAll(".thread-inspector-open").length === 3);
  assert.deepEqual(await titles(), ["Trace", "Browser", "Trace"]);
  // A tab dragged past its neighbor's middle takes its place on the drop.
  const [dragged, target] = [
    await page.locator(".thread-inspector-tab >> nth=1").boundingBox(),
    await page.locator(".thread-inspector-tab >> nth=0").boundingBox(),
  ];
  await page.mouse.move(dragged!.x + dragged!.width - 10, dragged!.y + dragged!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 10, target!.y + target!.height / 2, { steps: 8 });
  await page.mouse.up();
  await page
    .waitForFunction(() => [...document.querySelectorAll(".thread-inspector-open")].map((tab) => tab.textContent).join() === "Browser,Trace,Trace", undefined, {
      timeout: 5_000,
    })
    .catch(async () => assert.fail(`dragging a pane tab left them as ${(await titles()).join(", ")}`));
  // Its right-click menu closes the others; with focus in the pane, ⌘W closes its tab, and the last one the pane, the
  // thread staying.
  await page.click(".thread-inspector-open >> nth=2", { button: "right" });
  await page.click(".popover [role=menuitem] >> text=Close others");
  assert.deepEqual(await titles(), ["Trace"]);
  await page.focus(".thread-inspector-open");
  await page.keyboard.press("ControlOrMeta+w");
  await page.waitForSelector(".thread-inspector", { state: "detached" });
  assert.equal(await where(), thread, "⌘W in the pane closed the thread");
  // Opened with no tab, it offers the views, by letter too.
  await page.click("[aria-label='Open inspection pane']");
  await page.waitForSelector(".thread-inspector-empty >> text=Open a view");
  await page.keyboard.press("t");
  await page.waitForSelector(".thread-inspector-view .trj");
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
  // The sidebar's foot leads to settings (which take the sidebar while open); Escape comes back.
  await page.click(".sidebar-foot [aria-label=Settings]");
  await page.waitForFunction(() => location.pathname.startsWith("/settings"));
  await page.keyboard.press("Escape");
  await page
    .waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 })
    .catch(async () => assert.fail(`closing settings opened from the sidebar went to ${await where()}`));
  // An archived thread opens from the sidebar's archived fold.
  const archive = (archived: boolean) =>
    page.evaluate(
      async ({ id, archived }) => {
        const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
        await (await (window as any).lemma.service(Threads)).mark(id, { archived });
      },
      { id: seeded, archived },
    );
  await archive(true);
  await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await page.click(".archived-head");
  await page.click(`[data-section=archived] [data-session-row][href^="/threads/${seeded}?"]`);
  await page
    .waitForFunction((id) => location.pathname === `/threads/${id}`, seeded, { timeout: 5_000 })
    .catch(async () => assert.fail(`opening an archived thread from the sidebar ended on ${await where()}`));
  await page.click(".archived-head");
  await archive(false);
  await page.evaluate(async (id) => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    void (await (window as any).lemma.service(Threads)).select(id);
  }, seeded);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, seeded);
  await page.waitForSelector(".turn");
  // Unarchived while shown, the thread is listed again.
  const listedRow = (id: string) => `.thread-section.sorted li:not([data-section=archived]) [data-session-row][href^="/threads/${id}?"]`;
  await page.waitForSelector(listedRow(seeded));
  // Archived from under the pointer, it goes below among the archived and the next thread shows; unarchived from there,
  // it is on top again.
  const listed = () =>
    page.$$eval(".thread-section.sorted li:not([data-section=archived]) [data-session-row]", (rows) =>
      rows.map((row) => new URL(row.getAttribute("href")!, "http://x").pathname),
    );
  await page.hover(listedRow(seeded));
  await page.click(`.thread-row:has([data-session-row][href^="/threads/${seeded}?"]) .thread-archive`);
  await page
    .waitForFunction((id) => !location.pathname.endsWith(id), seeded, { timeout: 5_000 })
    .catch(async () => assert.fail(`archiving the thread shown stayed on ${await where()}`));
  assert(!(await listed()).includes(`/threads/${seeded}`), "an archived thread stayed among the active");
  await page.click(".archived-head");
  await page.hover(`[data-section=archived] [data-session-row][href^="/threads/${seeded}?"]`);
  await page.click(`[data-section=archived] .thread-row:has([data-session-row][href^="/threads/${seeded}?"]) .thread-archive`);
  await page
    .waitForFunction(
      (id) =>
        document
          .querySelector(".thread-section.sorted li:not([data-section=archived]) [data-session-row]")
          ?.getAttribute("href")
          ?.startsWith(`/threads/${id}?`),
      seeded,
      {
        timeout: 5_000,
      },
    )
    .catch(async () => assert.fail(`an unarchived thread is not on top: ${(await listed()).join(", ")}`));
  // The fold closed again, while it is there (nothing archived, it goes).
  if ((await page.locator(".archived-head[aria-expanded=true]").count()) > 0) await page.click(".archived-head");
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
  // A new thread is a session at once, not listed until it has a prompt; asked for again while it shows, it is the same
  // one; left with nothing written in it, it goes, as a tab closed does.
  await page.keyboard.press("ControlOrMeta+Shift+KeyO");
  await atBlankThread(page);
  const blankId = new URL(page.url()).pathname.split("/")[2]!;
  assert.equal(await page.locator(`.thread-list [href^="/threads/${blankId}?"]`).count(), 0, "a thread with nothing sent is listed");
  await page.evaluate(() => (window as any).blankThreads.newThread());
  assert.equal(new URL(page.url()).pathname.split("/")[2], blankId, "a second new thread was made beside an empty one");
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
  await page
    .waitForFunction((id) => !(window as any).blankThreads.list().some((session: any) => session.id === id), blankId, { timeout: 5_000 })
    .catch(() => assert.fail("an empty new thread, left, stays"));
  // One with a tab in its pane is kept: left, it stays, marked kept on the host so its sweep passes it over.
  await page.keyboard.press("ControlOrMeta+Shift+KeyO");
  await atBlankThread(page);
  const paneId = new URL(page.url()).pathname.split("/")[2]!;
  await showView(page, "trajectory");
  await page.waitForSelector(".thread-inspector");
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
  await page
    .waitForFunction((id) => (window as any).blankThreads.list().find((session: any) => session.id === id)?.kept === true, paneId, { timeout: 5_000 })
    .catch(async () =>
      assert.fail(
        `a blank thread with a pane tab is not kept: ${JSON.stringify(await page.evaluate((id) => (window as any).blankThreads.list().find((session: any) => session.id === id), paneId))}`,
      ),
    );
  await page.evaluate((id) => (window as any).blankThreads.remove(id), paneId);
  const threadIds = () => page.evaluate(() => ((window as any).blankThreads.list() as { id: string }[]).map((session) => session.id));
  // ⌘Enter runs the prompt in a new thread in the background: it is listed, and the thread shown stays.
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
  const known = await threadIds();
  await page.fill("textarea", "look into it elsewhere");
  // Held between its steps, so it is still at work when its card is measured below.
  await page.evaluate(() => (window as any).lemmaMock.holdSteers());
  await page.keyboard.press("ControlOrMeta+Enter");
  const background: string = await page
    .waitForFunction((known) => (window as any).blankThreads.list().find((session: any) => !known.includes(session.id))?.id, known, { timeout: 5_000 })
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(async () => assert.fail(`⌘Enter started no thread; ${JSON.stringify(await threadIds())}`));
  await page.waitForSelector(`.thread-list a[href^="/threads/${background}?"]`);
  // A card at work is as tall as one at rest, and stays so under the pointer: what it shows never changes its size, so
  // a pointer resting at its foot does not leave and find it again, over and over.
  const workingRow = `.thread-section.sorted .thread-row:has([data-session-row][href^="/threads/${background}?"])`;
  // Away from the list first: a card under the pointer shows its buttons where its state goes.
  await page.mouse.move(900, 400);
  await page
    .waitForSelector(`${workingRow} .thread-state[data-state=working]`, { timeout: 5_000 })
    .catch(() => assert.fail("a thread at work does not say so on its card"));
  const atRest = (await page.locator(workingRow).boundingBox())!;
  const idle = (await page.locator(`.thread-section.sorted .thread-row:not(.running):not(.slim)`).first().boundingBox())!;
  assert.equal(atRest.height, idle.height, `a card at work is ${atRest.height}px tall, one at rest ${idle.height}px`);
  await page.mouse.move(atRest.x + 40, atRest.y + atRest.height - 2);
  await page.waitForFunction((selector) => document.querySelector(selector)?.matches(":hover") === true, workingRow);
  assert.equal((await page.locator(workingRow).boundingBox())!.height, atRest.height, "a card at work changes its height under the pointer");
  await page.mouse.move(atRest.x + atRest.width + 400, atRest.y);
  await page.evaluate(() => (window as any).lemmaMock.releaseSteers());
  assert.equal(await where(), thread, "⌘Enter left the thread shown");
  assert.equal(await page.inputValue("textarea"), "", "⌘Enter left the prompt in the composer");
  // mod+1 goes to the first thread listed.
  const first = await page.getAttribute(".thread-section.sorted [data-session-row] >> nth=0", "href");
  await page.keyboard.press("ControlOrMeta+Digit1");
  await page
    .waitForFunction((path) => `${location.pathname}${location.search}` === path, first, { timeout: 5_000 })
    .catch(async () => assert.fail(`⌘1 went to ${await where()}, not ${first}`));
  // A prompt written in a new thread and left there is held as a draft above the threads, across a reload; opened, the
  // composer has it again; discarded from its row, the thread goes with it.
  await page.keyboard.press("ControlOrMeta+Shift+KeyO");
  await atBlankThread(page);
  const draftId = new URL(page.url()).pathname.split("/")[2]!;
  await page.fill("textarea", "hold this prompt");
  await page.click(`.thread-list a[href="${thread}"]`);
  const draftRow = `.drafts [data-session-row][href^="/threads/${draftId}?"]`;
  await page.waitForSelector(draftRow, { timeout: 5_000 }).catch(() => assert.fail("a prompt left in a new thread is not held as a draft"));
  await page.reload();
  await page.waitForSelector(draftRow, { timeout: 10_000 }).catch(() => assert.fail("a draft is gone after a reload"));
  await page.click(draftRow);
  await page
    .waitForFunction(() => document.querySelector("textarea")?.value === "hold this prompt", undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`a draft opened has ${JSON.stringify(await page.inputValue("textarea"))} in the composer`));
  assert.equal(await page.locator(draftRow).count(), 1, "a draft opened left the drafts");
  await page.keyboard.press("ControlOrMeta+Shift+KeyO");
  await page
    .waitForFunction((id) => location.pathname.startsWith("/threads/") && !location.pathname.endsWith(id), draftId, { timeout: 5_000 })
    .catch(() => assert.fail("a new thread asked for went back to the draft"));
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
  await page.hover(draftRow);
  await page.click(`.drafts .thread-row:has(${draftRow.slice(".drafts ".length)}) [aria-label^=Discard]`);
  await page.waitForSelector(draftRow, { state: "detached", timeout: 5_000 }).catch(() => assert.fail("a discarded draft is still listed"));
  await expose(page, "Threads");
  await page
    .waitForFunction((id) => !(window as any).services.Threads.list().some((session: any) => session.id === id), draftId, { timeout: 5_000 })
    .catch(() => assert.fail("a discarded draft's thread is still there"));
  // Pinned from under the pointer, a thread goes to the top. Dragged down past the first of the others, it goes there,
  // unpinned, and keeps that place across a reload.
  const sorted = () =>
    page.$$eval(".thread-section.sorted li:not([data-section=archived]) [data-session-row]", (rows) =>
      rows.map((row) => new URL(row.getAttribute("href")!, "http://x").pathname.split("/")[2]!),
    );
  const rowOf = (id: string) => `.thread-section.sorted .thread-row:has([data-session-row][href^="/threads/${id}?"])`;
  const before = await sorted();
  const pinning = before.at(-1)!;
  await page.hover(rowOf(pinning));
  await page.click(`${rowOf(pinning)} [aria-label^="Pin "]`);
  await page
    .waitForFunction(
      (id) => document.querySelector(".thread-section.sorted [data-session-row]")?.getAttribute("href")?.startsWith(`/threads/${id}?`),
      pinning,
      {
        timeout: 5_000,
      },
    )
    .catch(async () => assert.fail(`a thread pinned is not on top: ${(await sorted()).join(", ")}`));
  const next = (await sorted())[1]!;
  const from = (await page.locator(rowOf(pinning)).boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 10, { steps: 4 });
  // The sections' names show once it is picked up; then it is aimed below the next thread.
  await page.waitForSelector(".thread-head-label", { timeout: 5_000 }).catch(() => assert.fail("a thread picked up shows no sections"));
  const onto = (await page.locator(rowOf(next)).boundingBox())!;
  await page.mouse.move(from.x + 40, onto.y + onto.height - 4, { steps: 20 });
  await page
    .waitForSelector(".drop-verb:has-text('Unpin')", { timeout: 5_000 })
    .catch(() => assert.fail("a pinned thread dragged among the rest does not say it unpins"));
  // The name of the section it is in takes the accent, and a section, empty or not, is its name alone.
  assert.deepEqual(
    await page.$$eval(".thread-section.sorted .thread-head-label.target", (labels) => labels.map((label) => label.textContent)),
    ["Active"],
    "the section a dragged thread is in is not the one marked",
  );
  assert.equal(await page.locator(".thread-section.sorted .thread-head-slot").count(), 0, "an empty section offers a box to drop in");
  await page.mouse.up();
  const dropped = async () => {
    const now = await sorted();
    return now.indexOf(pinning) === now.indexOf(next) + 1;
  };
  await page
    .waitForFunction(
      ({ id, next }) => {
        const rows = [...document.querySelectorAll(".thread-section.sorted li:not([data-section=archived]) [data-session-row]")].map(
          (row) => new URL(row.getAttribute("href")!, "http://x").pathname.split("/")[2],
        );
        return (
          rows.indexOf(id) === rows.indexOf(next) + 1 && (window as any).services.Threads.list().find((session: any) => session.id === id)?.pinned !== true
        );
      },
      { id: pinning, next },
      { timeout: 5_000 },
    )
    .catch(async () => assert.fail(`a thread dragged below another is not there, unpinned: ${(await sorted()).join(", ")}`));
  await page.reload();
  await page.waitForSelector(rowOf(pinning));
  assert(await dropped(), `a dragged thread's place is lost on a reload: ${(await sorted()).join(", ")}`);
  // The sidebar's head: the toggle, and across from it search and a new thread.
  assert.deepEqual(
    await page.$$eval(".sidebar-head button", (buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ["Toggle sidebar", "Search threads", "New thread"],
    "the sidebar's head is not the toggle, search, and a new thread",
  );
  // A thread a plugin says waits on the person shows it where its time goes.
  await checkPlugin(page);
  await page.evaluate(async (id) => {
    const { ThreadWaits } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (window as any).removeWait = (window as any).checkSlots.add(ThreadWaits, {
      id: "check.wait",
      waiting: (sessionId: string) => (sessionId === id ? "Needs input" : undefined),
    });
  }, pinning);
  await page
    .waitForSelector(`${rowOf(pinning)} .thread-state[data-state=waiting]:has-text('Needs input')`, { timeout: 5_000 })
    .catch(() => assert.fail("a thread waiting on the person does not say so"));
  await page.evaluate(() => (window as any).removeWait());
  // Search floats: the head's button opens the palette's thread search, which finds what was said in threads too.
  await page.click(".sidebar-head [aria-label='Search threads']");
  await page.waitForFunction(() => (document.querySelector(".palette input") as HTMLInputElement | null)?.value === "@", undefined, { timeout: 5_000 });
  await page.keyboard.type("depend each");
  await page
    .waitForSelector(".palette-section:has-text('In messages') + .palette-row", { timeout: 5_000 })
    .catch(() => assert.fail("searching threads does not find what was said in them"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".palette input", { state: "detached" });
  // Adding a project: Tab goes into the highlighted folder, and Enter then opens that folder, not the one above it.
  await page.evaluate(async () => {
    const { Dialogs } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Dialogs)).open("add-project");
  });
  const folderPath = () => page.inputValue("[aria-label='Folder path']");
  await page.waitForFunction(() => (document.querySelector("[aria-label='Folder path']") as HTMLInputElement | null)?.value === "~/");
  await page.fill("[aria-label='Folder path']", "~/code/lem");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => (document.querySelector("[aria-label='Folder path']") as HTMLInputElement).value === "~/code/lemma/");
  await page.waitForSelector(".palette-row[data-active=true] >> text=Open");
  await page.keyboard.press("Enter");
  await page
    .waitForSelector("[aria-label='Folder path']", { state: "detached", timeout: 5_000 })
    .catch(async () => assert.fail(`Enter in a folder gone into left the picker at ${await folderPath()}`));
  await atBlankThread(page);
  assert.equal(await page.evaluate(() => (window as any).blankThreads.active().cwd), "~/code/lemma/", "Enter in a folder gone into opened another");
  // The project goes again, so the checks after see what they did.
  await page.evaluate(async () => {
    const { Workspace } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Workspace)).remove("~/code/lemma/");
  });
  // The background thread goes once its turn is done, so the checks after see the threads they did.
  await page.waitForFunction((id) => !(window as any).blankThreads.running().includes(id), background, { timeout: 20_000 });
  await page.evaluate((id) => (window as any).blankThreads.remove(id), background);
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
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
  await page.goto(`${url}/?mock#${id}`);
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
  const row = page.locator(`.thread-open[href^="/threads/${seeded}?"]`);
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
  await page.goto(`${url}/nowhere?mock`);
  await page.waitForSelector(".page-missing >> text=No page here");
  // A plugin's own route and page, reached by an ordinary link without reloading.
  await page.goto(`${url}/?mock`);
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
  assert.equal(await reruns("/broken/2?mock"), 3, "the route's own change did not rerun its reader");
  assert.equal(await reruns("/nowhere?mock"), 4, "leaving the route did not rerun its reader");
  assert.equal(await reruns("/elsewhere?mock"), 4, "an unrelated navigation reran a route's reader");
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
  assert.equal(await where(), "/after/1?mock=", "the router did not navigate after a page without a route");
  await page.evaluate(() => {
    (window as any).removeAfter();
    (window as any).removeMalformed();
  });
  errors.splice(0);

  // An example's web half runs as a user's would, from the plugin directory: examples/todo adds a view of the thread
  // and how its tool's calls show, and so does examples/glossary, which docs/building.md builds.
  const todo = readFileSync(resolve(root, "../../examples/todo/web.js"), "utf8");
  const glossary = readFileSync(resolve(root, "../../examples/glossary/glossary.web.js"), "utf8");
  await page.goto(`${url}/threads/s1?mock`);
  await settled(page);
  await page.waitForFunction(() => "lemmaMock" in window && "lemma" in window);
  await page.evaluate(
    ([todo, glossary]) => {
      const url = (source: string) => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      (window as any).lemmaMock.setWebFiles([
        { name: "todo/web.js", source: "user", kind: "script", path: "/plugins/todo/web.js", url: url(todo!) },
        { name: "glossary/glossary.web.js", source: "user", kind: "script", path: "/plugins/glossary/glossary.web.js", url: url(glossary!) },
      ]);
    },
    [todo, glossary],
  );
  await showView(page, "todo").catch(() => assert.fail("examples/todo added no Todos view"));
  await page.waitForSelector(".todo-view >> text=No todos in this thread.");
  assert.equal(
    await page.evaluate(async () => {
      const { ToolViews } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (window as any).lemma.slots().get(ToolViews, "todo")?.icon;
    }),
    "check",
    "examples/todo added no view of its tool's calls",
  );
  await showView(page, "glossary").catch(() => assert.fail("examples/glossary added no Glossary view"));
  await page.waitForSelector(".glossary-view >> text=No terms in this thread yet.");
  expectNoErrors("an example's web half");
  return "a part replaced and restored; six extension slots render what a plugin adds; @ completes files, / a command and its arguments, $ the skills, and a plugin adds completions; addresses survive reloads, back, and their page's plugin going off; a trajectory record's pipeline says who shaped it; a plugin adds a page; an example's web half adds a view and its tool's";
};

/** Shows a view of the open thread by its id in its pane, as its palette command does, once the thread has loaded. */
async function showView(page: Page, id: string): Promise<void> {
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
