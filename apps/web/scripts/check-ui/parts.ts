import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { boot, checkPlugin, expose, root, settled, switchTo, url } from "./shared.ts";

// 4–7: a part replaced, what plugins add to the extension slots, and the address.
export const parts = async (): Promise<string> => {
  const { page, errors, expectNoErrors } = await boot();
  // A sidebar collapsed is remembered apart from the sections folded in it: it opens again after a reload, and draws.
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
  await marker("WorkspaceBarItems", { side: "start" });
  for (const slot of ["ThreadHeader", "SidebarActions", "ComposerActions", "WorkspaceBarItems"]) {
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
  // An inspector tab: it lists for the selected plugin.
  await page.evaluate(async () => {
    const { PluginTabs, Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const lemma = (window as any).lemma;
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
  await page.click(`.session-open[href^="/threads/${seeded}"]`);
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
  // A view is in the address, and back returns to the one before.
  // The trajectory opens at its newest row, and scrolling up stops following it until Follow; a short window makes it scroll.
  await page.setViewportSize({ width: 1200, height: 320 });
  await showView(page, "trajectory");
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
        const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
        await (await (window as any).lemma.service(Threads)).mark(id, { archived });
      },
      { id: seeded, archived },
    );
  await archive(true);
  // Opened from a new thread, so where each step lands is unambiguous.
  await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await page.waitForFunction(() => location.pathname === "/");
  await page.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open("archived");
  });
  await page.waitForFunction(() => location.pathname === "/settings/archived");
  await expose(page, "Router");
  await page.click(
    `.archived-row:has-text("${await page.evaluate(async (id) => {
      const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
      const { sessionTitle } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return sessionTitle((await (window as any).lemma.service(Threads)).list().find((session: any) => session.id === id));
    }, seeded)}") .archived-title`,
  );
  // Closing settings goes back, which lands later; the thread's own navigation waits for it, in every engine (unheld,
  // Chromium and WebKit apply the back after it and end on "/", and Firefox keeps settings behind the thread). So the
  // thread shows once the back has landed, and stays.
  await page
    .waitForFunction((id) => !(window as any).services.Router.inspect().moving && location.pathname === `/threads/${id}`, seeded, { timeout: 5_000 })
    .catch(async () => assert.fail(`opening an archived thread ended on ${await where()}`));
  await page.goBack();
  await page
    .waitForFunction(() => location.pathname === "/", undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`back from an archived thread went to ${await where()}, not where settings were opened from`));
  await page.goForward();
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, seeded);
  await archive(false);
  await page.waitForSelector(".turn");
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
  // Closing them returns to the deleted thread's address, which leaves for a new thread.
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => location.pathname === "/", undefined, { timeout: 5_000 })
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
  const row = page.locator(`.session-open[href^="/threads/${seeded}"]`);
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
  // Unsent text: closing or reloading the tab asks first, while settings show too; sent or cleared, it does not.
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
  assert(await page.locator(".sidebar").isVisible(), "a failing page took the sidebar with it");
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
  // and how its tool's calls show.
  const todo = readFileSync(resolve(root, "../../examples/todo/web.js"), "utf8");
  await page.goto(`${url}/threads/s1?mock`);
  await settled(page);
  await page.waitForFunction(() => "lemmaMock" in window && "lemma" in window);
  await page.evaluate((source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    (window as any).lemmaMock.setWebFiles([{ name: "todo/web.js", source: "user", kind: "script", path: "/plugins/todo/web.js", url }]);
  }, todo);
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
  expectNoErrors("an example's web half");
  return "a part replaced and restored; six extension slots render what a plugin adds; @ completes files, / a command and its arguments, $ the skills, and a plugin adds completions; addresses survive reloads, back, and their page's plugin going off; a trajectory record's pipeline says who shaped it; a plugin adds a page; an example's web half adds a view and its tool's";
};

/** Shows a view of the open thread by its id, as its palette command does (the header has no switch), once the thread has loaded. */
async function showView(page: Page, id: string): Promise<void> {
  // The thread's menu shows once it has loaded; a view chosen before then gives way to the address it loads at.
  await page.waitForSelector(".main-head [aria-label='Thread actions']", { timeout: 10_000 });
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
  await page.waitForFunction((view) => location.pathname.endsWith(`/${view}`), id, { timeout: 10_000 });
}
