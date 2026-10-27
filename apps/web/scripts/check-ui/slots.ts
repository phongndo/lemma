import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { boot, checkPlugin } from "./shared.ts";

// 6: what plugins add to the places the defaults use: the extension slots, the palette, and the composer's completions.
export const slots = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot(await startHost());
  await checkPlugin(page);
  // A thread started in the project: its header has its card, and the composer's \`@\` finds the project's files.
  await page.click(".thread-start [aria-label=Project]");
  await page.click(".project-menu .menu-item >> text=lemma");
  await page.fill("textarea", "hello");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });

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
  // The card starts closed: open it to see its rows, and close it again after.
  await page.click(".main-head .card-toggle");
  for (const slot of ["ThreadHeader", "SidebarActions", "ComposerActions", "ThreadCard"]) {
    await page.waitForSelector(`.check-${slot}`, { timeout: 5_000 }).catch(() => assert.fail(`${slot} does not render what a plugin adds`));
  }
  await page.click(".main-head .card-toggle");
  await page.waitForSelector(".thread-card", { state: "detached", timeout: 5_000 });
  // A palette source: its items come up in the palette as they are searched for.
  await page.evaluate(async () => {
    const { Actions, PaletteSources } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const add = (window as any).checkSlots.add;
    ((window as any).removals ??= []).push(
      add(PaletteSources, {
        id: "check.source",
        order: 1_000,
        label: "checks",
        heading: "Checks",
        items: () => [{ key: "check:one", title: "Check item one", run: () => {} }],
      }),
      // An action with a page: picking it opens its list in place of the palette's.
      add(Actions, {
        id: "check.paged",
        title: "Check pages",
        page: () => ({ title: "Checked", items: () => [{ key: "check:paged", title: "Check page item", run: () => {} }] }),
        run: () => {},
      }),
    );
  });
  await page.keyboard.press("ControlOrMeta+k");
  await page.fill(".palette-input input", "check item one");
  await page.waitForSelector(".palette-row >> text=Check item one", { timeout: 5_000 }).catch(() => assert.fail("a palette source's items do not show"));
  // A page opens in place of the list; going back finds the list as it was left, what was typed and the row chosen.
  await page.fill(".palette-input input", "check pages");
  await page
    .waitForSelector(".palette-row[data-active=true] >> text=Check pages", { timeout: 5_000 })
    .catch(() => assert.fail("an action with a page is not listed"));
  await page.keyboard.press("Enter");
  await page.waitForSelector(".palette-row >> text=Check page item", { timeout: 5_000 }).catch(() => assert.fail("an action's page does not open"));
  assert.equal(await page.getAttribute(".palette-input input", "placeholder"), "Checked", "a page does not name itself in the field");
  assert.equal(await page.inputValue(".palette-input input"), "", "a page opens with what was typed before it");
  await page.keyboard.press("Backspace");
  await page
    .waitForSelector(".palette-row[data-active=true] >> text=Check pages", { timeout: 5_000 })
    .catch(() => assert.fail("Backspace on a page did not go back to its row"));
  assert.equal(await page.inputValue(".palette-input input"), "check pages", "going back loses what was typed");
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
  return "six extension slots render what a plugin adds; a palette source and an action's page; @ completes files, / a command and its arguments, $ the skills, and a plugin adds completions; an inspector tab, and the Cost tab's share of the latest request";
};
