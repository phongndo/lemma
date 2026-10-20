import assert from "node:assert/strict";
import { log, open, settled, url } from "./shared.ts";

// 11 on: pages that start elsewhere: with no provider, connecting one, with a web half, and from an older app.
export const separate = async (): Promise<string> => {
  const { errors, expectNoErrors } = log();

  // 11. No provider set up: the chat, not settings, and its notice opens Providers, which returns to the chat once one connects.
  const fresh = await open();
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto(`${url}/?mock`);
  await fresh.waitForSelector(".composer-callout, .settings");
  assert.equal(await fresh.locator(".settings").count(), 0, "with no provider set up, the app opened settings rather than the chat");
  await fresh.click(".composer-callout button >> text=Connect");
  await fresh.waitForSelector(".settings >> text=Connect a provider to start chatting");
  await fresh.locator(".provider", { hasText: "OpenCode Zen" }).locator(".provider-connect").click();
  await fresh.fill(".connect input[type=password]", "sk-check");
  await fresh.press(".connect input[type=password]", "Enter");
  await fresh.waitForSelector(".settings", { state: "detached", timeout: 5_000 }).catch(() => assert.fail("connecting the first provider left settings open"));
  await fresh.waitForSelector("textarea");
  assert.equal(await fresh.locator(".composer-callout").count(), 0, "the no-provider notice stayed after connecting one");
  const connection = fresh.locator(".main-head .connection");
  assert.ok((await connection.boundingBox())!.width < 30, "the header's connection should be a dot, not text");
  assert.equal((await connection.textContent())?.trim(), "Connected", "the dot's live region must carry its status as text, which is announced");
  // Reload is its own plugin: an action (listed in the palette, keys bindable) that its footer button, right of the dot, runs.
  assert.ok(
    await fresh.evaluate(async () => {
      const { Actions } = (await import("/src/ui/api.ts" as string)).api.contracts;
      return (window as any).lemma.slots().get(Actions, "reload.app") !== undefined;
    }),
    "reload is not an action",
  );
  // The dot is the open thread's: first of its header's end, before the thread card's switch; the thread's actions are
  // its sidebar row's menu, so the header has none.
  assert.equal(await fresh.locator(".main-head [aria-label='Thread actions']").count(), 0, "the thread's header has a menu of its actions");
  const cardToggle = fresh.locator(".main-head .card-toggle");
  if ((await cardToggle.count()) > 0) {
    const [dot, toggle] = await Promise.all([connection.boundingBox(), cardToggle.boundingBox()]);
    assert.ok(dot!.x < toggle!.x, "the connection's dot should sit left of the thread card's switch");
  }
  // Reload is a command (the palette, its keys): run it as one is.
  await Promise.all([
    fresh.waitForEvent("load"),
    fresh.evaluate(async () => {
      const { Actions } = (await import("/src/ui/api.ts" as string)).api.contracts;
      (window as any).lemma.slots().get(Actions, "reload.app")?.run();
    }),
  ]);
  await fresh.waitForSelector(".main-head .connection-connected");
  // What the host's reload changed is reported on the page it reloads to.
  await fresh
    .getByText(/^Reloaded: /)
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("a reload did not report what it changed"));
  await fresh.close();
  expectNoErrors("connecting a first provider and reloading the UI");

  // 12. Connecting a provider, each way, in one dialog: a sign-in page with its paste fallback, a device code, a question after a
  // documentation link, and a new custom provider whose key is answered for it; closing cancels, and leaves no link behind.
  const connect = await open();
  connect.on("pageerror", (error) => errors.push(error.message));
  await connect.goto(`${url}/settings/providers?mock=fresh`);
  await connect.locator(".provider", { hasText: "OpenAI" }).first().locator(".provider-connect").click();
  await connect.click(".menu-item >> text=Sign in with ChatGPT");
  await connect.waitForSelector(".connect .connect-url");
  assert.equal(await connect.locator(".connect .connect-paste input").count(), 1, "the sign-in page's dialog has no paste-the-address fallback");
  assert.equal(await connect.locator(".toast").count(), 0, "the sign-in's link showed as a toast as well as in its dialog");
  await connect.mouse.click(5, 400);
  assert.equal(await connect.locator(".connect").count(), 1, "a click on the backdrop cancelled the login");
  await connect.click(".connect .dialog-foot >> text=Cancel");
  await connect.waitForSelector(".connect", { state: "detached" });
  await connect.waitForSelector(".provider:has-text('OpenAI') >> text=Connect");
  assert.equal(await connect.locator(".toast").count(), 0, "cancelling left a toast behind: its link, or a failure");

  await connect.locator(".provider", { hasText: "GitHub Copilot" }).first().locator(".provider-connect").click();
  await connect.click(".menu-item >> text=/GitHub Copilot/");
  await connect.waitForSelector(".connect .connect-code >> text=WDJB-MJHT");
  await connect.keyboard.press("Escape");
  await connect.waitForSelector(".connect", { state: "detached" });

  await connect.fill("input[aria-label='Search providers']", "bedrock");
  await connect.locator(".provider", { hasText: "Amazon Bedrock" }).first().locator(".provider-connect").click();
  await connect.waitForSelector(".connect .connect-info >> text=AWS profiles");
  assert.equal(await connect.locator(".connect .connect-paste").count(), 0, "a documentation link made the question look like a sign-in page's fallback");
  // A blank answer is one: the default profile.
  await connect.click(".connect .connect-question button[type=submit]");
  await connect.waitForSelector(".connect", { state: "detached" });
  await connect.waitForSelector(".provider:has-text('Amazon Bedrock') >> text=Manage");
  await connect.fill("input[aria-label='Search providers']", "");

  await connect.locator(".provider", { hasText: "Custom provider" }).locator(".provider-connect").click();
  await connect.waitForSelector(".custom-provider-form");
  await connect.evaluate(() => {
    const seen = new MutationObserver(() => {
      if (document.querySelector(".dialog.connect:not(.custom-provider)") !== null) (window as any).sawConnect = true;
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  const fields = connect.locator(".custom-provider-form input");
  await fields.nth(0).fill("Gateway");
  await fields.nth(1).fill("http://localhost:4000/v1");
  await fields.nth(2).fill("m1");
  await fields.nth(3).fill("sk-gateway");
  await connect.click(".custom-provider >> text=Add provider");
  await connect.waitForSelector(".custom-provider", { state: "detached", timeout: 10_000 });
  assert.notEqual(await connect.evaluate(() => (window as any).sawConnect), true, "adding a custom provider with a key opened the connect dialog too");
  // One whose key the host refuses (the mock refuses any with "wrong" in it): the connect dialog says why, and takes another.
  await connect.locator(".provider", { hasText: "Custom provider" }).locator(".provider-connect").click();
  await connect.waitForSelector(".custom-provider-form");
  await fields.nth(0).fill("Proxy");
  await fields.nth(1).fill("http://localhost:4001/v1");
  await fields.nth(2).fill("m1");
  await fields.nth(3).fill("sk-wrong");
  await connect.click(".custom-provider >> text=Add provider");
  await connect
    .waitForSelector(".dialog.connect:not(.custom-provider) .connect-problem", { timeout: 10_000 })
    .catch(() => assert.fail("a custom provider's refused key did not open the connect dialog to say why"));
  await connect.fill(".dialog.connect:not(.custom-provider) input[type=password]", "sk-right");
  await connect.press(".dialog.connect:not(.custom-provider) input[type=password]", "Enter");
  await connect.waitForSelector(".dialog.connect", { state: "detached", timeout: 10_000 });
  await connect.close();
  expectNoErrors("connecting providers each way");

  // A web half's Tailwind classes work as the app's own: compiled in the page with them into one sheet, so a file's
  // `tw:px-4` beats the app's `tw:p-0.5` as one build would, drawn from the tokens, and gone with the file. The same
  // file is a theme pack: its theme, accent, and Appearance row are offered beside Lemma's own, and leave with it.
  const styled = await open();
  styled.on("pageerror", (error) => errors.push(error.message));
  await styled.goto(`${url}/?mock`);
  await settled(styled);
  await styled.waitForFunction(() => "lemmaMock" in window && "lemma" in window);
  await styled.evaluate(() => {
    const source = `export default ({ defineWebPlugin, contracts: { Slots, SidebarFooter, Themes, Accents, SettingsGroups, SectionIds }, html }) =>
      defineWebPlugin({ id: "check-look", requires: { slots: Slots }, setup: ({ slots }) => {
        slots.add(SidebarFooter, { id: "check-utilities", order: 1, component: () => html\`<span class="check-utilities tw:p-0.5 tw:px-4 tw:bg-accent tw:rounded">styled</span>\` });
        slots.add(Themes, { id: "check-night", title: "Check night", scheme: "dark", colors: { bg: "rgb(10, 20, 30)" } });
        slots.add(Themes, { id: "check-day", title: "Check day", scheme: "light", colors: { bg: "rgb(250, 240, 220)" } });
        slots.add(Accents, { id: "check-teal", title: "Check teal", color: "rgb(0, 128, 128)" });
        slots.add(SettingsGroups, { id: "check-look", section: SectionIds.appearance, title: "Check", entries: () => [{ text: "check look", view: () => html\`<p class="check-look-row">a plugin's row</p>\` }] });
      } });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    (window as any).lemmaMock.setWebFiles([{ name: "check-look.js", source: "user", kind: "script", path: "/check/check-look.js", url }]);
  });
  await styled.waitForSelector(".check-utilities", { timeout: 10_000 }).catch(() => assert.fail("a web half's plugin did not draw"));
  const look = () =>
    styled.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".check-utilities")!);
      return { left: style.paddingLeft, top: style.paddingTop, radius: style.borderTopLeftRadius, background: style.backgroundColor };
    });
  const accentNow = () =>
    styled.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--accent)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
  assert.deepEqual(
    await look(),
    { left: "16px", top: "2px", radius: "10px", background: await accentNow() },
    "a web half's utilities are not compiled in order, or not from the tokens",
  );
  await styled.evaluate(() => document.documentElement.style.setProperty("--accent", "rgb(1, 2, 3)"));
  assert.equal((await look()).background, "rgb(1, 2, 3)", "a web half's utility does not follow its token");
  await styled.evaluate(() => document.documentElement.style.removeProperty("--accent"));

  const painted = (token: string) => styled.evaluate((token) => document.documentElement.style.getPropertyValue(token), token);
  await styled.keyboard.press("ControlOrMeta+,");
  await styled.click(".settings-nav >> text=Appearance");
  await styled.waitForSelector(".check-look-row", { timeout: 5_000 }).catch(() => assert.fail("a plugin's row is not in the Appearance section"));
  await styled.click("[role=radio][aria-label='Check teal']");
  await styled.waitForFunction(() => document.documentElement.style.getPropertyValue("--accent") === "rgb(0, 128, 128)", undefined, { timeout: 5_000 });
  await styled.click("[role=radiogroup][aria-label=Scheme] [role=radio]:has-text('Dark')");
  await styled.click("button[aria-label='Dark theme']");
  await styled.click("[role=menuitemradio]:has-text('Check night')");
  await styled
    .waitForFunction(
      () => document.documentElement.style.getPropertyValue("--bg") === "rgb(10, 20, 30)" && document.documentElement.dataset.theme === "dark",
      undefined,
      {
        timeout: 5_000,
      },
    )
    .catch(() => assert.fail("a theme a plugin offers does not paint"));
  // A theme sets base colors; the rest derive from them, so its surfaces follow its background.
  const raised = await styled.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-raised"));
  assert.match(raised, /rgb\(10, 20, 30\)/, `a theme's surfaces do not derive from its background: --bg-raised is ${raised}`);
  // A light theme's too: its raised surfaces rise from its background, not to plain white.
  await styled.click("[role=radiogroup][aria-label=Scheme] [role=radio]:has-text('Light')");
  await styled.click("button[aria-label='Light theme']");
  await styled.click("[role=menuitemradio]:has-text('Check day')");
  await styled.waitForFunction(() => document.documentElement.style.getPropertyValue("--bg") === "rgb(250, 240, 220)", undefined, { timeout: 5_000 });
  const day = await styled.evaluate(async () => (await import("/src/ui/api.ts" as string)).api.look.tokenColor("--bg-raised"));
  const [red, , blue] = [1, 3, 5].map((at) => Number.parseInt(day.slice(at, at + 2), 16)) as [number, number, number];
  assert(day !== "#ffffff" && red - blue > 15, `a light theme's raised surface does not follow its background: ${day}`);
  // The look changes with a stylesheet too (a web half's), once a linked one has loaded: what renderers redraw on.
  await styled.evaluate(async () => {
    const { onLookChange } = (await import("/src/ui/api.ts" as string)).api.look;
    (window as any).looks = 0;
    (window as any).stopLooks = onLookChange(() => (window as any).looks++);
    const style = document.createElement("style");
    style.textContent = ":root { --check-look: 1; }";
    document.head.append(style);
  });
  await styled
    .waitForFunction(() => (window as any).looks >= 1, undefined, { timeout: 5_000 })
    .catch(() => assert.fail("a stylesheet added is no look change"));
  const before = await styled.evaluate(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = URL.createObjectURL(new Blob([":root { --check-look: 2; }"], { type: "text/css" }));
    link.addEventListener("load", () => ((window as any).linkLoaded = true));
    document.head.append(link);
    return (window as any).looks as number;
  });
  await styled
    .waitForFunction((before) => (window as any).linkLoaded === true && (window as any).looks >= before + 2, before, { timeout: 5_000 })
    .catch(() => assert.fail("a linked stylesheet's loading is no look change"));
  await styled.evaluate(() => (window as any).stopLooks());

  await styled.evaluate(() => (window as any).lemmaMock.setWebFiles([]));
  await styled.waitForSelector(".check-utilities", { state: "detached", timeout: 10_000 });
  await styled
    .waitForFunction(() => document.querySelector("style[data-lemma-utilities]") === null, undefined, { timeout: 5_000 })
    .catch(() => assert.fail("the web halves' utilities outlived the files"));
  // What the file offered leaves with it: the look falls back, and the page says what is missing.
  await styled.waitForFunction(() => document.documentElement.style.getPropertyValue("--bg") === "", undefined, { timeout: 5_000 });
  assert.equal(await painted("--accent"), "", "an accent outlived the plugin that offered it");
  assert.equal(await styled.locator(".check-look-row").count(), 0, "a plugin's Appearance row outlived it");
  await styled.waitForSelector('text="check-teal" is not offered', { timeout: 5_000 }).catch(() => assert.fail("a missing accent is not explained"));
  await styled.close();
  expectNoErrors("a web half's Tailwind classes and theme pack");

  // An older app kept the scheme and width in the browser: the first start carries them into config and forgets them.
  const carried = await open();
  carried.on("pageerror", (error) => errors.push(error.message));
  await carried.addInitScript(() => {
    if (sessionStorage.getItem("check-carried") !== null) return;
    sessionStorage.setItem("check-carried", "1");
    localStorage.setItem("lemma.theme", "dark");
    localStorage.setItem("lemma.contentWidth", "full");
  });
  await carried.goto(`${url}/?mock`);
  await settled(carried);
  await carried
    .waitForFunction(
      () =>
        document.documentElement.dataset.theme === "dark" &&
        document.documentElement.style.getPropertyValue("--content") === "none" &&
        localStorage.getItem("lemma.theme") === null &&
        localStorage.getItem("lemma.contentWidth") === null,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => assert.fail("an older app's scheme and width were not carried into config"));
  await carried.close();
  expectNoErrors("carrying an older app's appearance into config");

  // A form question: drawn as a plugin's settings are, its Submit waiting on the field it needs, and what is set the answer.
  const form = await open();
  form.on("pageerror", (error) => errors.push(error.message));
  await form.goto(`${url}/?mock`);
  await settled(form);
  await form.evaluate(async () => {
    const { Commands } = (await import("/src/ui/api.ts" as string)).api.contracts;
    const commands = await (window as any).lemma.service(Commands);
    void commands.run(commands.list().find((command: { readonly id: string }) => command.id === "workspace.pull-request"));
  });
  const dialog = form.locator(".dialog", { hasText: "Open a pull request" });
  await dialog.waitFor({ timeout: 5_000 }).catch(() => assert.fail("a form question does not show"));
  const submit = dialog.getByRole("button", { name: "Submit" });
  assert.ok(await submit.isDisabled(), "a form's Submit is open before the field it needs is set");
  await dialog.locator("#config-title").fill("Add forms");
  await dialog.locator("#config-title").blur();
  await dialog.locator("#config-base").selectOption("develop");
  await submit.click();
  await form
    .getByText('Opened "Add forms" into develop')
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("a form's answer did not reach the command that asked it"));
  await form.close();
  expectNoErrors("answering a form");
  // A new thread in a git project can start in a new worktree, from the remote's version of its branch: the project's
  // menu chooses the worktree, the branch menu's switch the remote, which the branch says, and the first prompt asks for it.
  const fork = await open();
  fork.on("pageerror", (error) => errors.push(error.message));
  await fork.goto(`${url}/?mock`);
  await fork.waitForSelector(".thread-chat.starting .thread-start [aria-label=Project]", { timeout: 10_000 });
  await fork.click(".thread-start [aria-label=Project]");
  await fork.click(".project-menu .menu-item >> text=lemma");
  await fork.click(".thread-start [aria-label=Project]");
  await fork.click(".project-menu .menu-item >> text=New worktree");
  await fork.click(".thread-start [aria-label='Worktree base branch']");
  await fork.click(".branch-menu .menu-toggle-row [role=switch]");
  await fork
    .waitForSelector(".thread-start [aria-label='Worktree base branch'] >> text=/from origin\\//", { timeout: 5_000 })
    .catch(() => assert.fail("a new worktree to start from the remote does not say so on its branch"));
  await fork.keyboard.press("Escape");
  await fork.fill("textarea", "work apart");
  await fork.keyboard.press("Enter");
  await fork
    .waitForFunction(() => (window as any).lemmaMock.worktreesAsked().length > 0, undefined, { timeout: 10_000 })
    .catch(() => assert.fail("a new thread in a new worktree asked for none"));
  assert.equal(
    (await fork.evaluate(() => (window as any).lemmaMock.worktreesAsked().at(-1))).fromRemote,
    true,
    "a new worktree to start from the remote was asked for without it",
  );
  await fork.close();
  expectNoErrors("starting a new thread in a new worktree from the remote");

  return "a form question is drawn as settings are and answers its command; with no provider it opens in the chat, whose notice leads to Providers and back; providers connect each way in one dialog; a web half's Tailwind classes compile with the app's, from its tokens; a theme pack's theme, accent, and row come and go with it; an older app's appearance carries over; a new thread starts in a new worktree from the remote's branch when asked";
};
