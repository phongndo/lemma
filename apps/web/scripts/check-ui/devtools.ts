import assert from "node:assert/strict";
import { atBlankThread, boot, checkPlugin, drawn, settled, url } from "./shared.ts";

// 8–9: the devtools, and a turn while it runs.
export const devtools = async (): Promise<string> => {
  const { page, errors, expectNoErrors } = await boot();

  // 8. The devtools: docked under the app, each panel shows the app as it runs, and every panel's data reads as JSON.
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open(undefined);
  });
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await page.waitForSelector(".devtools");
  // Where the app ends: the window's bottom with nothing docked under it (a bar across the top leaves its height as it is).
  const appHeight = () => page.evaluate(() => document.querySelector(".app")!.getBoundingClientRect().bottom);
  // On every page, and across a reload: what covers the app (settings) leaves what is docked under it in view.
  const dockOnTop = () =>
    page.evaluate(() => {
      const tab = document.querySelector(".devtools [role=tab]")?.getBoundingClientRect();
      return tab !== undefined && document.elementFromPoint(tab.x + tab.width / 2, tab.y + tab.height / 2)?.closest(".devtools") !== null;
    });
  const firstThread: string = await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    return (await (window as any).lemma.service(Threads)).list()[0].id;
  });
  const sections = ["general", "appearance", "keyboard", "providers", "plugins", "projects", "archived"].map((section) => `/settings/${section}`);
  for (const path of ["/", `/threads/${firstThread}`, `/threads/${firstThread}/trajectory`, ...sections, "/nowhere"]) {
    await page.evaluate(async (path) => {
      const { Router } = (await import("/src/ui/api.ts" as string)).api.contracts;
      (await (window as any).lemma.service(Router)).navigate(path);
    }, path);
    // The new-thread page goes on to a blank thread; a thread's address naming a view opens it in the thread's pane, and
    // then names the thread.
    if (path === "/") await atBlankThread(page);
    else if (path.endsWith("/trajectory"))
      await page.waitForFunction(
        (path) => location.pathname === path.replace(/\/trajectory$/, "") && document.querySelector(".thread-inspector .trj") !== null,
        path,
      );
    else await page.waitForFunction((path) => location.pathname === path, path);
    await drawn(page);
    assert(await dockOnTop(), `the devtools are hidden at ${path}`);
  }
  await page.reload();
  await page.waitForSelector(".devtools", { timeout: 10_000 }).catch(() => assert.fail("a reload closed the devtools"));
  assert(await dockOnTop(), "the devtools are hidden after a reload");
  // The walk ended at an address nothing shows; back to a new thread.
  await page.evaluate(async () => {
    const { Router } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Router)).navigate("/");
  });
  await atBlankThread(page);
  assert((await appHeight()) < 900 - 100, "the app did not make room for the devtools");
  // Routes: why an address shows what it does, and who shows each route.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Routes");
  await page.fill("[aria-label='Address to explain']", "/threads/anything/trajectory");
  await page.waitForSelector("[aria-label=Routes] tr:has(td:text-is('thread')):has-text('shown')");
  await page.waitForSelector("[aria-label=Routes] tr:has(td:text-is('settings')):has-text('no-match')");
  await page.waitForSelector("[aria-label='Route details'] >> text=the most specific fit");
  await page.waitForSelector("[aria-label=Routes] tr:has-text('/threads/:id/:view?') >> text=threads.view");
  // Navigation: the journal has what the router did.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Navigation");
  await page.waitForSelector("[aria-label='Router journal'] >> text=matched");
  // Host events: the host's own stream and its domains' streams, and a session's id goes to its thread's trajectory.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Host events");
  await page.waitForSelector("[aria-label=Events] tbody tr[data-row]");
  await page
    .waitForSelector("[aria-label=Events] tr:has(td:text-is('agent.activity')):has(td:text-is('subscribed'))", { timeout: 5_000 })
    .catch(() => assert.fail("the Host events panel does not follow the agent's activity"));
  // Pinning a thread has its sessions.changes report it, naming the session.
  const pinned: string = await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const threads = await (window as any).lemma.service(Threads);
    const id = threads.list()[0].id;
    await threads.mark(id, { pinned: true });
    await threads.mark(id, { pinned: false });
    return id;
  });
  await page.click(`[aria-label=Events] a >> text=${pinned}`);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}` && document.querySelector(".thread-inspector .trj") !== null, pinned);
  await page.waitForSelector(".devtools");
  // Channels: what host plugins serve, each with the plugin that answers for it.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Channels");
  await page.click("[aria-label=Channels] td:text-is('sessions.log')");
  await page.waitForSelector("[aria-label='Channel details'] >> text=Session log");
  await page.waitForSelector("[aria-label=Channels] tr:has(td:text-is('agent.prompt')) button:text-is('agent.loop')");
  // The keys work a panel's rows as the pointer does: ↓ selects the next, Escape closes the details, and from the
  // table ↓ selects the first.
  const channelKeys = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[aria-label=Channels] tbody tr[data-key]")].map((row) => row.dataset.key!),
  );
  const afterLog = channelKeys[channelKeys.indexOf("sessions.log") + 1];
  assert(afterLog !== undefined, "no channel follows sessions.log");
  await page.press("[aria-label=Channels] tr[data-key='sessions.log']", "ArrowDown");
  await page.waitForSelector(`[aria-label=Channels] tr[data-key='${afterLog}'][aria-selected=true]`);
  await page.keyboard.press("Escape");
  await page.waitForSelector("[aria-label='Channel details']", { state: "detached" });
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector(`[aria-label=Channels] tr[data-key='${channelKeys[0]}'][aria-selected=true]`);
  await page.waitForSelector("[aria-label='Channel details']");
  // A plugin's name anywhere opens it in the Plugins panel: everything it does, and what depends on it.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Routes");
  await page.click("[aria-label=Routes] tr:has(td:text-is('/threads/:id/:view?')) button:text-is('threads.view')");
  await page.waitForSelector("[aria-label='Plugin details'] .dt-details-title >> text=threads.view");
  await page.waitForSelector("[aria-label='Plugin details'] tr:has(td:text-is('pages')):has(td:text-is('thread-view.new'))");
  // What the runtime provides is the web app's, not missing: no capability lacks a provider.
  await page.fill("[aria-label='Filter plugins']", "threads.client");
  await page.click("[aria-label=Plugins] tr:has(td:first-child:text-is('threads.client'))");
  await page.waitForSelector("[aria-label='Plugin details'] tr:has(td:text-is('lemma-web/Router')) >> text=the web app");
  await page.fill("[aria-label='Filter plugins']", "");
  await page.waitForSelector(".dt-status >> text=/^0 capabilities without a provider$/");
  // The host's plugins too, and each hook's chain in run order.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Hooks");
  await page.click("[aria-label=Hooks] tr:has(td:text-is('lemma/agent.request'))");
  // By phase: agent.loop shapes the request, then context.compaction, in `fit`, sizes what every other handler made.
  for (const [position, [id, place]] of [
    ["agent.loop", "shape · order 0"],
    ["context.compaction", "fit · order 0"],
  ].entries()) {
    await page.waitForSelector(`[aria-label='Hook details'] tr:has(td:text-is('${position + 1}')):has(td:text-is('${place}')) >> button:text-is('${id}')`);
  }
  // Registries: the web app's slots, live, with who fills each and how to add to it.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Registries");
  await page.fill("[aria-label='Filter registries']", "pages");
  await page.click("[aria-label=Registries] tr:has(td:first-child:text-is('pages'))");
  await page.waitForSelector("[aria-label='Registry items'] tr:has(td:text-is('thread-view.new')):has(button:text-is('threads.view'))");
  // A slot names the contract declaring it, from the contracts the runtime lists (`WebPlugins.contracts`).
  await page.waitForSelector("[aria-label='Registry details'] .dt-details-title >> text=Pages from @lemma/web");
  await page.fill("[aria-label='Filter registries']", "integrations.kinds");
  await page.click("[aria-label=Registries] tr:has(td:first-child:text-is('integrations.kinds'))");
  await page.waitForSelector("[aria-label='Registry details'] .dt-details-title >> text=IntegrationKinds from @lemma/integrations");
  // Inspectors: what host plugins let you look into, as tables.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Inspectors");
  await page.click("[aria-label=Inspectors] tr:has-text('Tools')");
  await page.waitForSelector("[aria-label='Inspector snapshot'] td:text-is('bash')");
  // Trace: the page's spans as traces, each opening to its waterfall; a filter narrows them; each plugin's time; and
  // the composition's changes, the host's from its start.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Trace");
  await page.click("[aria-label='Which trace'] button:text-is('Page')");
  await page.fill("[aria-label='Filter spans']", "plugin:frame name:core.activate");
  await page.waitForSelector("[aria-label=Spans] tr[data-row]:has(button:text-is('frame.shell')) .trc-name >> text=core.activate");
  assert(!(await page.locator("[aria-label=Spans] button:text-is('look.kit')").count()), "the trace's filter lets another plugin's spans through");
  await page.click("[aria-label='Which trace'] button:text-is('Plugins')");
  await page.waitForSelector("[aria-label='Plugins by time'] tr:has(button:text-is('frame.shell'))");
  assert(!(await page.locator("[aria-label='Plugins by time'] button:text-is('look.kit')").count()), "the trace's plugin profile ignores its filter");
  await page.click("[aria-label='Which trace'] button:text-is('Host')");
  await page.click("[aria-label='Which trace'] button:text-is('Changes')");
  await page.waitForSelector("[aria-label='Composition changes'] td:text-is('start')");
  await page.click("[aria-label='Which trace'] button:text-is('Spans')");
  await page.fill("[aria-label='Filter spans']", "");
  // A plugin's details lead to its spans.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Plugins");
  await page.click("[aria-label='Plugins toolbar'] button:text-is('Host')");
  await page.fill("[aria-label='Filter plugins']", "agent.loop");
  await page.click("[aria-label=Plugins] tr:has(td:first-child:text-is('agent.loop'))");
  await page.click("[aria-label='Plugin details'] button:text-is('Spans')");
  await page.waitForFunction(() => (document.querySelector("[aria-label='Filter spans']") as HTMLInputElement | null)?.value === "plugin:agent.loop");
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Plugins");
  await page.fill("[aria-label='Filter plugins']", "");
  await page.click("[aria-label='Plugins toolbar'] button:text-is('Web app')");
  const snapshot = await page.evaluate(async () => {
    const { Devtools } = (await import("/src/ui/api.ts" as string)).api.contracts;
    return JSON.parse(JSON.stringify((await (window as any).lemma.service(Devtools)).snapshot()));
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "devtools.channels",
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

  // A plugin answering a prompt instead of placing it (`AgentInputHook`): handled, it leaves the composer and the
  // composer says so; refused, it stays, and the composer says why.
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.evaluate(() =>
    (window as any).lemmaMock.answerPrompts({
      "/ping": { kind: "handled", by: "check", message: "pong" },
      "/nope": { kind: "refused", by: "check", reason: "not today" },
    }),
  );
  await page.fill("textarea", "/ping");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[aria-label='Prompt answered by a plugin'] >> text=handled the prompt: pong");
  assert.equal(await page.inputValue("textarea"), "", "a handled prompt stayed in the composer");
  await page.fill("textarea", "/nope");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[aria-label='Prompt answered by a plugin'] >> text=refused the prompt: not today");
  assert.equal(await page.inputValue("textarea"), "/nope", "a refused prompt left the composer");
  await page.click("[aria-label='Prompt answered by a plugin'] [aria-label=Dismiss]");
  await page.waitForSelector("[aria-label='Prompt answered by a plugin']", { state: "detached" });
  await page.fill("textarea", "");
  await page.evaluate(() => (window as any).lemmaMock.answerPrompts({}));

  // 9. While a turn runs: Enter steers it (`whenBusy`), the steer shown where it will join and in no queue row, Alt+Enter
  // queues a prompt for after it, and a queued one can steer it after all or be withdrawn. The turn holds its steers
  // until the queue is done with, so none depends on timing.
  await page.goto(`${url}/?mock`);
  await settled(page);
  // A new thread's prompt is in the middle of the page, under its start line: where it works and its mode, which the
  // composer's own row does not hold.
  await page
    .waitForSelector(".thread-chat.starting .thread-start .agent-mode-chip", { timeout: 5_000 })
    .catch(() => assert.fail("a new thread has no start line with its mode under its prompt"));
  assert.equal(await page.locator(".composer-controls [aria-label=Mode]").count(), 0, "a new thread's mode is picked in the composer");
  // The line is under the prompt, and its menus open below it, each centered on its item.
  await page.click(".thread-start [aria-label=Mode]");
  await page.waitForSelector(".agent-mode-menu");
  const [modeItem, modeMenu, prompt] = await Promise.all(
    [".thread-start [aria-label=Mode]", ".agent-mode-menu", ".composer-dock textarea"].map((selector) => page.locator(selector).boundingBox()),
  );
  assert(modeItem!.y > prompt!.y, "a new thread's start line is not under its prompt");
  // The prompt (its box, with any notice over it) is in the middle of the page, the line under it moving it nowhere.
  const [composer, chat] = await Promise.all(
    [".composer-dock > :not(.thread-start)", ".thread-chat"].map((selector) => page.locator(selector).first().boundingBox()),
  );
  assert(Math.abs(composer!.y + composer!.height / 2 - (chat!.y + chat!.height / 2)) < 2, "a new thread's prompt is not in the middle of the page");
  assert(
    modeMenu!.y > modeItem!.y && Math.abs(modeMenu!.x + modeMenu!.width / 2 - (modeItem!.x + modeItem!.width / 2)) < 2,
    "a start line's menu does not open below its item, centered on it",
  );
  // Started in Creator: a mode other than the default, which the thread card shows.
  await page.click(".agent-mode-menu .agent-mode-item >> text=Creator");
  await page.waitForSelector(".agent-mode-menu", { state: "detached" });
  await page.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open(undefined);
  });
  // The turn shows running before the host is seen to take the first prompt; a steer sent in between goes once it is,
  // and is not cleared away with the first prompt's text. Held open on purpose, so the check does not depend on timing.
  // Held until released, so the steer is typed and sent while the first prompt is still going out, every run.
  await page.evaluate(() => (window as any).lemmaMock.holdTurnStarted());
  await page.evaluate(() => (window as any).lemmaMock.holdSteers());
  await page.fill("textarea", "start a turn");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".send.stop");
  // Sent, the thread has started: its prompt goes to the bottom, and the start line with it.
  await page
    .waitForSelector(".thread-chat.starting", { state: "detached", timeout: 5_000 })
    .catch(() => assert.fail("a thread's prompt stays in the middle of the page once its first prompt is sent"));
  // Its facts are in its card, open over the chat until closed, its mode first (not being the default); the composer
  // holds none of them.
  await page
    .waitForSelector(".thread-card .menu-item:first-child >> text=Creator mode", { timeout: 5_000 })
    .catch(() => assert.fail("a started thread's card does not show its mode first"));
  assert.equal(
    await page.locator(".composer-dock .context-row, .composer-dock .agent-mode-chip, .workspace-bar").count(),
    0,
    "a thread's facts are in its composer",
  );
  await page.click(".main-head .card-toggle");
  await page.waitForSelector(".thread-card", { state: "detached", timeout: 5_000 }).catch(() => assert.fail("the thread card's switch does not close it"));
  await page.click(".main-head .card-toggle");
  await page.waitForSelector(".thread-card", { timeout: 5_000 }).catch(() => assert.fail("the thread card's switch does not open it again"));
  await page.fill("textarea", "steer it");
  // Something written takes the stop button's place with the steer button, rather than adding one beside it.
  await page
    .waitForSelector(".send.stop", { state: "detached" })
    .catch(() => assert.fail("the stop button stays beside the steer button while a prompt is written"));
  assert.equal(await page.locator(".send:not(.stop)").count(), 1, "no steer button takes the stop button's place");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".steer-pending:has-text('steer it')").count(), 0, "a steer went out before the prompt before it was taken");
  await page.evaluate(() => (window as any).lemmaMock.releaseTurnStarted());
  await page.waitForSelector(".steer-pending:has-text('steer it')").catch(() => assert.fail("a steer sent while a turn runs is not shown where it will join"));
  // Not yet placed, it is on the prompt rail already, as any prompt the chat shows.
  const railTicks = () =>
    page
      .locator("nav[aria-label='Prompts'] .prompt-tick")
      .evaluateAll((ticks) => ticks.map((tick) => tick.getAttribute("aria-label")?.replace(/^Prompt \d+ of \d+: /, "")));
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("nav[aria-label='Prompts'] .prompt-tick")].some((tick) => tick.getAttribute("aria-label")?.endsWith(": steer it")),
      undefined,
      {
        timeout: 5_000,
      },
    )
    .catch(async () => assert.fail(`a steer not yet placed has no tick on the prompt rail: ${(await railTicks()).join(", ")}`));
  assert.equal(await page.locator(".queued").count(), 0, "a steer has a row in the composer's queue");
  assert.equal(await page.inputValue("textarea"), "", "a steer that was taken stayed in the composer");
  await page.waitForSelector(".send.stop").catch(() => assert.fail("the stop button does not come back once the box is empty"));
  // Until the turn takes it, a steer can be withdrawn from beside it.
  await page.fill("textarea", "never mind");
  await page.keyboard.press("Enter");
  await page.hover(".steer-pending:has-text('never mind')");
  await page.click(".steer-pending:has-text('never mind') .steer-withdraw");
  await page
    .waitForSelector(".steer-pending:has-text('never mind')", { state: "detached" })
    .catch(() => assert.fail("a steer cannot be withdrawn before it joins"));
  await page.fill("textarea", "for later");
  await page.keyboard.press("Alt+Enter");
  await page.waitForSelector(".composer-queue .queued:has-text('for later')");
  await page.fill("textarea", "and after that");
  await page.keyboard.press("Alt+Enter");
  // The queue's thin header counts it, and closes it to that one line and opens it again, the focus staying in the prompt.
  await page.waitForSelector(".queue-head .queue-count:text-is('2')").catch(() => assert.fail("the queue's header does not count it"));
  assert.deepEqual(
    await page.locator(".queued .queued-text").allTextContents(),
    ["for later", "and after that"],
    "the queue is not open with its prompts in order",
  );
  await page.click(".queue-head");
  await page.waitForSelector(".queued", { state: "hidden" }).catch(() => assert.fail("the queue's header does not close it"));
  assert(
    await page.evaluate(() => document.getElementById(document.querySelector(".queue-head")!.getAttribute("aria-controls")!) !== null),
    "the closed queue's header names a list that is not there",
  );
  assert(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "the queue's header took the focus from the prompt");
  await page.click(".queue-head");
  await page.waitForSelector(".queued:has-text('and after that')").catch(() => assert.fail("the queue's header does not open it again"));
  // The row is a part: a plugin's own replaces it, and the default returns when that goes.
  await checkPlugin(page);
  await page.evaluate(async () => {
    const { ComposerQueuedPart } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (window as any).removeRow = (window as any).checkSlots.add(ComposerQueuedPart, {
      id: "check.queued",
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
  await page.click(".queued:has-text('and after that') .queued-remove");
  await page.waitForSelector(".composer-queue", { state: "detached" });
  // A follow-up promoted from its row steers the turn after all, and shows where it will join. It ends in a file
  // mention, so the menu is open: the send button with Alt queues it as Alt+Enter would.
  await page.fill("textarea", "steer after all @README.md");
  await page.click(".send:not(.stop)", { modifiers: ["Alt"] });
  await page.click(".queued:has-text('steer after all') .queued-promote");
  await page.waitForSelector(".steer-pending:has-text('steer after all')").catch(() => assert.fail("a queued prompt promoted from its row does not steer"));
  await page.waitForSelector(".composer-queue", { state: "detached" });
  await page.evaluate(() => (window as any).lemmaMock.releaseSteers());
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  await page.waitForSelector(".steer-pending", { state: "detached" });
  // One turn, holding every prompt but the withdrawn one: the steers where they joined.
  assert.deepEqual(
    await page.locator(".turn").evaluateAll((turns) => turns.map((turn) => [...turn.querySelectorAll(".user-text")].map((user) => user.textContent))),
    [["start a turn", "steer it", "steer after all @README.md"]],
    "the steers are not shown in the turn they joined",
  );
  // Every prompt the chat shows has its tick on the prompt rail, alike: the turn's, then each steer where it joined.
  await page
    .waitForFunction(() => document.querySelectorAll("nav[aria-label='Prompts'] .prompt-tick").length === 3, undefined, { timeout: 5_000 })
    .catch(async () => assert.fail(`the prompt rail has ${(await railTicks()).length} ticks for a prompt and two steers`));
  assert.deepEqual(await railTicks(), ["start a turn", "steer it", "steer after all @README.md"], "the prompt rail does not hold every prompt in the chat");
  assert.deepEqual(
    await page.locator(".turn .user-prompt:has(.steer-mark) .user-text").allTextContents(),
    ["steer it", "steer after all @README.md"],
    "the steers are not marked as steers, or the prompt is",
  );
  expectNoErrors("steering and queueing");

  // Up in an empty prompt brings back what was sent in the thread, newest first; Down goes newer, and past the newest
  // empties the prompt. One brought back opens no menu for the mention it ends with, which would take the next Up.
  await page.focus("textarea");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.inputValue("textarea"), "steer after all @README.md", "Up in an empty prompt does not bring back the last one sent");
  assert.equal(await page.locator(".completions").count(), 0, "a prompt brought back opens the completion menu");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.inputValue("textarea"), "steer it", "Up again does not bring back the prompt before");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.inputValue("textarea"), "", "Down past the newest prompt does not empty the composer");

  // A turn runs on while the page leaves its thread and comes back, asking the agent what it has streamed, and while
  // the agent restarts under it: the page follows on, and its prompt is placed once.
  const turnPath = new URL(page.url()).pathname;
  await page.fill("textarea", "keep going");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".assistant.draft", { timeout: 5_000 });
  await page.evaluate(async () => {
    const { Router } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Router)).navigate("/");
  });
  await atBlankThread(page);
  await page.goBack();
  await page.waitForFunction((path) => location.pathname === path, turnPath);
  await page.evaluate(async () => {
    const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
    await (await (window as any).lemma.service(Client)).restartPlugin("agent.loop", { force: true });
  });
  await page
    .waitForFunction(() => document.querySelectorAll(".turn-footer").length === 2, undefined, { timeout: 20_000 })
    .catch(() => assert.fail("a turn did not finish on screen after its thread was left and the agent restarted"));
  assert.equal(await page.locator(".user-text:text-is('keep going')").count(), 1, "a prompt sent again after the agent restarted was placed twice");
  const reported: string[] = await page.evaluate(async () => {
    const { Notify } = (await import("/src/ui/api.ts" as string)).api.contracts;
    return (await (window as any).lemma.service(Notify))
      .toasts()
      .filter((toast: { level: string }) => toast.level === "error")
      .map((toast: { message: string }) => toast.message);
  });
  assert.deepEqual(reported, [], "the agent restarting mid-turn was reported as a failure");
  expectNoErrors("leaving a running turn's thread and restarting the agent under it");

  // A send that fails (the connection dropped, say) keeps its request id: sending the same prompt again, even after
  // moving to another thread and back, is a retry the host can recognise. An edit makes it a new prompt.
  await page.evaluate(async () => {
    const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const channel = (await (window as any).lemma.service(Client)).channel;
    const call = channel.call;
    const sent: (string | undefined)[] = ((window as any).sentIds = []);
    channel.call = (target: string | { id: string }, payload?: { requestId?: string }) => {
      if ((typeof target === "string" ? target : target.id) !== "agent.prompt") return call(target, payload);
      sent.push(payload?.requestId);
      return sent.length === 1 || sent.length === 3 ? Promise.reject(new Error("connection lost")) : call(target, payload);
    };
  });
  const sentIds = () => page.evaluate(() => (window as any).sentIds as (string | undefined)[]);
  await page.evaluate(async () => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    void (await (window as any).lemma.service(Threads)).select(undefined);
  });
  await atBlankThread(page);
  await page.fill("textarea", "retry me");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).sentIds.length === 1);
  // The refused prompt is back in the composer, in the blank thread it was written in.
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
  // Escape in the prompt stops the running turn when pressed twice (`stop`); the first says so, and stops nothing, nor
  // does one held down. The turn is held before its steers, so it is still running for every press. Presses that must
  // land within the window go in one task, so none depends on how fast the page answers.
  await page.evaluate(() => (window as any).lemmaMock.holdSteers());
  await page.waitForSelector(".send.stop");
  const escapes = (repeats: readonly boolean[]) =>
    page.evaluate((repeats) => {
      const input = document.querySelector("textarea")!;
      for (const repeat of repeats)
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat, bubbles: true, composed: true, cancelable: true }));
      return document.querySelector(".composer-hint") !== null;
    }, repeats);
  // A steer the stopped turn never places waits for the next prompt, with the queue, where it can be withdrawn.
  await page.fill("textarea", "held for the next");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".steer-pending:has-text('held for the next')");
  await page.focus("textarea");
  assert(await escapes([false]), "a first Escape while a turn runs does not say a second stops it");
  // The window closes: a press after it is a first again.
  await page.waitForSelector(".composer-hint", { state: "detached" });
  assert(!(await escapes([true])), "Escape held down counts as presses");
  assert(!(await escapes([false, false])), "a second Escape counts as a first");
  // The turn ends cancelled once it goes on to its steers.
  await page.evaluate(() => (window as any).lemmaMock.releaseSteers());
  await page.waitForSelector(".turn[data-end='cancelled'] .turn-footer", { timeout: 20_000 }).catch(() => assert.fail("a second Escape did not stop the turn"));
  assert.equal(await page.locator(".turn[data-end='cancelled'] .badge").count(), 0, "a stopped turn is marked as cancelled");
  await page.waitForSelector(".queued:has-text('held for the next')").catch(() => assert.fail("a stopped turn's steer is not with the queue"));
  assert.equal(await page.locator(".steer-pending").count(), 0, "a stopped turn's steer still shows as joining it");
  await page.click(".queued:has-text('held for the next') .queued-remove");
  await page.waitForSelector(".composer-queue", { state: "detached" }).catch(() => assert.fail("a stopped turn's steer cannot be withdrawn"));
  // The failed sends were reported; nothing else went wrong.
  errors.splice(0);
  return "the devtools show routes, navigation, host events and streams, channels, plugins, hooks, registries, inspectors, and the traces, filtered, by plugin, and their changes; a running turn takes steers and queued prompts, promotes a queued one, and outlives its thread being left and the agent restarting; Up brings back sent prompts; a failed send is retried with its request id; Escape twice stops a turn";
};
