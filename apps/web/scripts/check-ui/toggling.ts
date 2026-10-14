import assert from "node:assert/strict";
import { domainPlugins } from "../../../../scripts/plugins.ts";
import { boot, expose, settled, switchTo } from "./shared.ts";

// 1–3: booting, the parts, and every plugin off and on.
export const toggling = async (): Promise<string> => {
  // 1. The app boots without errors.
  const { page, warnings, expectNoErrors } = await boot();

  // 2. Every declared part has a provider.
  const unfilled: string[] = await page.evaluate(async () => {
    const contracts = (await import("/src/ui/api.ts" as string)).api.contracts;
    const slots = (window as any).lemma.slots();
    return Object.values(contracts)
      .filter((value: any) => typeof value?.name === "string" && value.name.startsWith("part."))
      .filter((part: any) => slots.first(part) === undefined)
      .map((part: any) => part.name);
  });
  assert.deepEqual(unfilled, [], "parts nothing provides");

  // 3. Every plugin turns off and on, the way the Plugins page switches it; a locked one (pinned, or needed by one) stays on.
  const plugins: { id: string; locked: boolean; source: string }[] = await page.evaluate(() =>
    (window as any).lemma.plugins.list().map((plugin: any) => ({ id: plugin.id, locked: plugin.locked !== undefined, source: plugin.source })),
  );
  // The bundled list holds the web half of every plugin in domains/, under the id its folder names.
  assert.deepEqual(
    plugins
      .filter((plugin) => plugin.source === "bundled")
      .map((plugin) => plugin.id)
      .sort(),
    [...domainPlugins()]
      .filter(([, plugin]) => plugin.web !== undefined)
      .map(([id]) => id)
      .sort(),
    "the bundled web halves are not those the domains' manifests list (src/bundled.ts, scripts/plugins.ts)",
  );
  const toggled: string[] = [];
  const locked: string[] = [];
  for (const { id, locked: isLocked } of plugins) {
    const stylesheets = () => page.evaluate((plugin) => document.head.querySelectorAll(`style[data-plugin="${plugin}"]`).length, id);
    const styled = await stylesheets();
    const stateOff = await switchTo(page, id, false);
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
    await switchTo(page, id, true);
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
  // Only the pinned plugins and what they need stay on; the runtime is the app's, with no row to switch.
  assert.deepEqual([...locked].sort(), ["frame.pages", "frame.shell", "settings.page", "settings.plugins"], "the plugins kept on");
  const runtimeRows = plugins.filter(({ id }) => ["client", "app", "slots", "router", "notify", "host-plugins", "interactions"].includes(id));
  assert.deepEqual(runtimeRows, [], "the runtime has rows among the plugins");
  // Turning a plugin off takes what needs it along, as the Plugins page shows: nothing to warn about.
  assert.deepEqual(
    warnings.filter((warning) => warning.includes("is not loaded")),
    [],
    "turning plugins off warned about the plugins that need them",
  );

  // The Plugins page needs no plugin that can be turned off: a line of its summary leaves with the plugin that adds it
  // (the turns running, with threads), and its pieces work without kit, from the page itself.
  await page.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open("plugins");
  });
  const running = page.locator(".host-facts dt:text-is('Running')");
  await running.waitFor({ timeout: 5_000 }).catch(() => assert.fail("the Plugins page does not show the turns running"));
  assert.notEqual(await switchTo(page, "threads.client", false), "active", "threads.client did not turn off");
  await running.waitFor({ state: "detached", timeout: 5_000 }).catch(() => assert.fail("the turns running outlived threads"));
  await switchTo(page, "threads.client", true);
  await running.waitFor({ timeout: 5_000 }).catch(() => assert.fail("the turns running did not return with threads"));
  // Domains start folded: kit's row shows once its domain is open.
  const domainRow = (domain: string) => page.locator(`.inspector-table [role=rowgroup][aria-label='${domain}'] .inspector-domain`);
  await domainRow("look").click();
  const kit = page.locator(".inspector-row[data-key='web:look.kit']");
  const kitState = () => page.evaluate(() => (window as any).lemma.plugins.list().find((plugin: any) => plugin.id === "look.kit").state);
  // A web half can neither change a bundled part's fallback nor give its own part one: its `definePart` takes none.
  const fallbacks = await page.evaluate(async () => {
    const { api } = await import("/src/ui/api.ts" as string);
    const { fallbackOf, TogglePart } = api.contracts;
    const declared = fallbackOf(TogglePart);
    const mine = () => "a web half's";
    return { kept: fallbackOf(api.definePart("toggle", mine)) === declared, own: fallbackOf(api.definePart("check.own", mine)) === undefined };
  });
  assert.deepEqual(fallbacks, { kept: true, own: true }, "a web half set a part's fallback");
  await kit.locator("[role=switch]").click();
  await kit
    .locator("input[type=checkbox]")
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("with kit off, the Plugins page has no switch to turn it back on"));
  assert.notEqual(await kitState(), "active", "kit did not turn off from its switch");
  // With kit off, the parts the page draws are their plain fallbacks: its search filters, a plugin's settings form
  // refuses what is not of a field's type and saves what is, and its icons still mark their buttons.
  const filter = page.locator("input[type=search][aria-label='Filter plugins']");
  await filter.waitFor({ timeout: 5_000 }).catch(() => assert.fail("with kit off, the Plugins page has no search field"));
  await filter.fill("agent.loop");
  const agent = page.locator(".inspector-row[data-key='host:agent.loop']");
  await kit.waitFor({ state: "detached", timeout: 5_000 }).catch(() => assert.fail("with kit off, the Plugins page's search does not filter"));
  await agent.click();
  await page.click(".inspector-tabs [role=tab] >> text=Settings");
  const maxSteps = page.getByLabel("Max steps");
  await maxSteps.waitFor({ timeout: 5_000 }).catch(() => assert.fail("with kit off, a plugin's settings form does not show"));
  assert.notEqual((await page.locator("[aria-label='Close details']").textContent())?.trim(), "", "with kit off, an icon button is blank");
  await maxSteps.fill("2.5");
  await maxSteps.press("Tab");
  assert.equal(
    await maxSteps.evaluate((input: HTMLInputElement) => input.validationMessage),
    "maxSteps must be a whole number",
    "with kit off, a bad value is not refused",
  );
  await maxSteps.fill("150");
  await maxSteps.press("Tab");
  await expose(page, "HostPlugins");
  await page
    .waitForFunction(
      () => (window as any).services.HostPlugins.list().find((plugin: any) => plugin.id === "agent.loop").config.values.maxSteps === 150,
      undefined,
      {
        timeout: 5_000,
      },
    )
    .catch(() => assert.fail("with kit off, a plugin's settings form does not save"));
  await filter.fill("");
  await kit.locator("input[type=checkbox]").click();
  await kit
    .locator("[role=switch]")
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("the plain switch did not turn kit back on"));
  assert.equal(await kitState(), "active", "kit is not back on");
  expectNoErrors("turning threads and kit off and on with the Plugins page open");

  // The table shows the plugins as they are organized: a row per domain, in order, folded until opened, which opens to
  // its plugins, a plugin's two halves one row of them.
  const domains = await page.evaluate(() =>
    [...document.querySelectorAll(".inspector-table [role=rowgroup]")].map((group) => group.getAttribute("aria-label") ?? ""),
  );
  assert.deepEqual(
    domains,
    [...domains].sort((a, b) => a.localeCompare(b)),
    "the Plugins page's domains are not in order",
  );
  const bash = page.locator(".inspector-row[data-key='host:tools.bash']");
  assert.equal(await bash.count(), 0, "a domain's plugins show before it is opened");
  await domainRow("tools").click();
  await bash.waitFor({ timeout: 5_000 }).catch(() => assert.fail("opening the tools domain does not show tools.bash, both halves"));
  await domainRow("tools").click();
  await bash.waitFor({ state: "detached", timeout: 5_000 }).catch(() => assert.fail("a domain does not fold again"));
  // A narrow page scrolls once: the table with the summary under it, or a plugin's details in the table's place. Two
  // panes each half the height cut both off.
  const wide = page.viewportSize()!;
  const close = page.locator("[aria-label='Close details']");
  if (await close.isVisible()) await close.click();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".inspector-split")!).display === "block", undefined, { timeout: 5_000 });
  const stacked = await page.evaluate(() => {
    const table = document.querySelector(".inspector-table")!.getBoundingClientRect();
    const detail = document.querySelector(".inspector-detail")!.getBoundingClientRect();
    return { below: detail.top >= table.bottom, tableScrolls: getComputedStyle(document.querySelector(".inspector-table")!).overflowY !== "visible" };
  });
  assert.deepEqual(stacked, { below: true, tableScrolls: false }, "in a narrow page, the Plugins page's summary does not follow its table");
  if ((await domainRow("agent").getAttribute("aria-expanded")) !== "true") await domainRow("agent").click();
  await page.click(".inspector-row[data-key='host:agent.loop']");
  await page
    .waitForSelector(".inspector-table", { state: "hidden", timeout: 5_000 })
    .catch(() => assert.fail("in a narrow page, a plugin's details do not take the table's place"));
  await page.click("[aria-label='Close details']");
  await page
    .waitForSelector(".inspector-row[data-key='host:agent.loop']", { timeout: 5_000 })
    .catch(() => assert.fail("closing a plugin's details does not return to the table"));
  await page.setViewportSize(wide);

  // The runtime is not a plugin: with every plugin off that can be, the router and the messages still answer.
  const unlocked = plugins.filter((plugin) => !plugin.locked).map((plugin) => plugin.id);
  const configureAll = (enabled: boolean) =>
    page.evaluate(
      async ({ ids, enabled }) => {
        const { Client } = (await import("/src/ui/api.ts" as string)).api.contracts;
        await (await (window as any).lemma.service(Client)).configure(Object.fromEntries(ids.map((id: string) => [id, { enabled }])));
      },
      { ids: unlocked, enabled },
    );
  const active = () =>
    page.evaluate(() =>
      (window as any).lemma.plugins
        .list()
        .filter((plugin: any) => plugin.state === "active")
        .map((plugin: any) => plugin.id),
    );
  await configureAll(false);
  await page.waitForFunction((count) => (window as any).lemma.plugins.list().filter((plugin: any) => plugin.state === "active").length === count, 4);
  assert.deepEqual(
    [...(await active())].sort(),
    ["frame.pages", "frame.shell", "settings.page", "settings.plugins"],
    "plugins still running with every plugin off",
  );
  const answers = await page.evaluate(async () => {
    const { Notify, Router } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const lemma = (window as any).lemma;
    const notify = await lemma.service(Notify);
    const id = notify.toast({ level: "info", message: "the runtime answers" });
    return { path: (await lemma.service(Router)).location().pathname, kept: notify.toasts().some((toast: any) => toast.id === id) };
  });
  assert.deepEqual(answers, { path: "/settings/plugins", kept: true }, "with every plugin off, the runtime does not answer");
  await configureAll(true);
  await page.waitForFunction(
    (count) => (window as any).lemma.plugins.list().filter((plugin: any) => plugin.state === "active").length === count,
    plugins.length,
  );
  expectNoErrors("turning every plugin off and on at once");

  // A web half providing part of the runtime is left out, saying so, and the app's own goes on: its toasts still show.
  await page.evaluate(() => {
    const source = `export default ({ defineWebPlugin, contracts: { Notify } }) =>
      defineWebPlugin({ id: "my-notify", provides: { notify: Notify }, setup: () => ({ notify: {} }) });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    (window as any).lemmaMock.setWebFiles([{ name: "my-notify.js", source: "user", kind: "script", path: "/check/my-notify.js", url }]);
  });
  await page
    .waitForFunction(() => (window as any).lemma.plugins.list().some((plugin: any) => plugin.id === "my-notify" && plugin.problem !== undefined), undefined, {
      timeout: 10_000,
    })
    .catch(() => assert.fail("a web half providing Notify was not left out"));
  assert(
    warnings.some((warning) => warning.includes('"my-notify" is left out') && warning.includes('Stop providing "lemma-web/Notify"')),
    "a web half providing Notify was left out without a warning",
  );
  await page.evaluate(async () => {
    const { Notify } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Notify)).toast({ level: "info", message: "still the app's own" });
  });
  await page
    .waitForSelector(".toast >> text=still the app's own", { timeout: 5_000 })
    .catch(() => assert.fail("toasts stopped with a web half providing Notify"));
  await page.evaluate(() => (window as any).lemmaMock.setWebFiles([]));
  await page.waitForFunction(() => !(window as any).lemma.plugins.list().some((plugin: any) => plugin.id === "my-notify"));
  expectNoErrors("a web half providing part of the runtime");

  // A web half is the plugin its file is named for (the host knows its id by that): one defining another is not run.
  await page.evaluate(() => {
    const source = `export default ({ defineWebPlugin }) => defineWebPlugin({ id: "other", setup: () => {} });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    (window as any).lemmaMock.setWebFiles([{ name: "named.web.js", plugin: "named", source: "user", kind: "script", path: "/check/named.web.js", url }]);
  });
  await page
    .waitForFunction(() => (window as any).lemma.plugins.problems().some((problem: string) => problem.includes('defines "other"')), undefined, {
      timeout: 10_000,
    })
    .catch(() => assert.fail("a web half defining a plugin other than its file's name was not refused"));
  assert(!(await page.evaluate(() => (window as any).lemma.plugins.list().some((plugin: any) => plugin.id === "other"))), "a misnamed web half ran");
  await page.evaluate(() => (window as any).lemmaMock.setWebFiles([]));
  return `booted; every part provided; ${toggled.length - locked.length} plugins turned off and on, ${locked.length} locked ones kept on (${locked.join(", ")}); the Plugins page filters, saves settings, and keeps its switches without kit; the runtime answers with every plugin off, and a web half providing Notify is left out`;
};
