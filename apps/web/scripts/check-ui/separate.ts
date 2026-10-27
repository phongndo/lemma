import assert from "node:assert/strict";
import { settled as eventually } from "../../../../scripts/e2e.ts";
import { scripted, startHost } from "./hosts.ts";
import { git } from "./seed.ts";
import { drawn, log, open, settled, url } from "./shared.ts";

/** A plugin of the user's with a command that asks a form, as a plugin's settings are asked for. */
const PULL_REQUEST = `import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { Interaction } from "@lemma/contracts";
import { Commands } from "@lemma/commands";

const Request = Schema.Struct({
  title: Schema.String.annotate({ title: "Title" }),
  base: Schema.Literals(["main", "develop"]).pipe(Schema.withDecodingDefaultType(Effect.sync(() => "main"))).annotate({ title: "Base" }),
  draft: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))).annotate({ title: "Draft" }),
});

export default definePlugin({
  id: "pull-request",
  uses: ["lemma/commands@1"],
  requires: { interaction: Interaction },
  setup: ({ interaction }, { add }) => {
    add(Commands, {
      id: "pull-request.open",
      title: "Open pull request…",
      category: "Git",
      run: async () => {
        const asked = await interaction.form("Open a pull request", Request, "From main");
        return { message: \`Opened "\${asked.title}" into \${asked.base}\${asked.draft ? " as a draft" : ""}\` };
      },
    });
  },
});
`;

// 11 on: pages that start elsewhere: with no provider, connecting one, with a web half, from an older app, and profiles.
// Pages share a host where what one leaves changes nothing the next checks: hosts are processes, and a machine has only
// so many.
export const separate = async (): Promise<string> => {
  const { errors, expectNoErrors } = log();

  // 11. No provider set up: the chat, not settings, and its notice opens Providers, which returns to the chat once one
  // connects. The scripted provider needs a key here, which no one has given it.
  const bare = await startHost({
    threads: false,
    plugins: (provider) => ({
      "llm.pi-ai": {
        config: {
          providers: [
            scripted(provider, {
              apiKey: { env: "SCRIPTED_API_KEY" },
              models: [
                { id: "scripted", name: "Scripted model", reasoning: true },
                { id: "alternate", name: "Alternate model", reasoning: true },
              ],
            }),
          ],
        },
      },
    }),
  });
  const fresh = await open(bare);
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto(`${url}/`);
  await fresh.waitForSelector(".composer-callout, .settings");
  assert.equal(await fresh.locator(".settings").count(), 0, "with no provider set up, the app opened settings rather than the chat");
  await fresh.click(".composer-callout button >> text=Connect");
  await fresh.waitForSelector(".settings >> text=Connect a provider to start chatting");
  // A provider the user added offers its key, its logo, and its removal.
  await fresh.locator(".provider", { hasText: "Scripted" }).locator(".provider-connect").click();
  await fresh.click(".menu-item >> text=Paste an API key");
  await fresh.fill(".connect input[type=password]", "sk-check");
  await fresh.press(".connect input[type=password]", "Enter");
  await fresh.waitForSelector(".settings", { state: "detached", timeout: 5_000 }).catch(() => assert.fail("connecting the first provider left settings open"));
  await fresh.waitForSelector("textarea");
  assert.equal(await fresh.locator(".composer-callout").count(), 0, "the no-provider notice stayed after connecting one");
  // With a model, ⌘⇧M and ⌘⇧E open the composer's model and reasoning pickers.
  await fresh.keyboard.press("ControlOrMeta+Shift+KeyM");
  await fresh.waitForSelector(".popover.model-menu", { timeout: 5_000 }).catch(() => assert.fail("⌘⇧M opened no model picker"));
  await fresh.waitForSelector('.model-row[data-active="true"]');
  const pickerPositions = () =>
    fresh.locator(".model-menu, .model-name, .model-current, .model-star").evaluateAll((elements) =>
      elements.map((element) => {
        const item = element as HTMLElement;
        return [item.offsetLeft, item.offsetTop, item.offsetWidth, item.offsetHeight];
      }),
    );
  const beforeHints = await pickerPositions();
  await fresh.keyboard.down("ControlOrMeta");
  await fresh.waitForSelector(".model-row[data-quick-key]");
  assert.deepEqual(await pickerPositions(), beforeHints, "holding the quick-pick modifier moved the model picker's contents");
  await fresh.keyboard.up("ControlOrMeta");
  // A stationary pointer must not leave a favorite action on the old row once the keys move the highlight.
  await fresh.locator(".model-row").nth(1).hover();
  await fresh.waitForFunction(() => getComputedStyle(document.querySelectorAll(".model-row .model-star")[1]!).opacity === "1");
  await fresh.keyboard.press("ArrowUp");
  await fresh
    .waitForFunction(() => getComputedStyle(document.querySelectorAll(".model-row .model-star")[1]!).opacity === "0", undefined, { timeout: 1_000 })
    .catch(() => assert.fail("keyboard navigation left the favorite action on the previously hovered model"));
  assert.equal(await fresh.locator('.model-row[data-active="true"]').count(), 1, "the model picker must have one active row");
  await fresh.keyboard.press("Escape");
  await fresh.waitForSelector(".popover", { state: "detached", timeout: 5_000 });
  await fresh.keyboard.press("ControlOrMeta+Shift+KeyE");
  await fresh.waitForSelector(".popover:not(.model-menu) [role=menuitemradio]", { timeout: 5_000 }).catch(() => assert.fail("⌘⇧E opened no reasoning picker"));
  await fresh.keyboard.press("Escape");
  await fresh.waitForSelector(".popover", { state: "detached", timeout: 5_000 });
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
  // Each a real sign-in, reaching nothing beyond this machine: OpenRouter's page (its answer comes back to a port of the
  // host's own), Kimi Code's device code (asked of the scripted provider), Amazon Bedrock's questions, and custom
  // providers on the scripted one.
  const connect = await open(bare);
  connect.on("pageerror", (error) => errors.push(error.message));
  await connect.goto(`${url}/settings/providers`);
  await connect.locator(".provider", { hasText: "OpenRouter" }).first().locator(".provider-connect").click();
  await connect.click(".menu-item >> text=Sign in with OpenRouter");
  await connect.waitForSelector(".connect .connect-url");
  assert.equal(await connect.locator(".connect .connect-paste input").count(), 1, "the sign-in page's dialog has no paste-the-address fallback");
  assert.equal(await connect.locator(".toast").count(), 0, "the sign-in's link showed as a toast as well as in its dialog");
  await connect.mouse.click(5, 400);
  assert.equal(await connect.locator(".connect").count(), 1, "a click on the backdrop cancelled the login");
  await connect.click(".connect .dialog-foot >> text=Cancel");
  await connect.waitForSelector(".connect", { state: "detached" });
  await connect.waitForSelector(".provider:has-text('OpenRouter') >> text=Connect");
  assert.equal(await connect.locator(".toast").count(), 0, "cancelling left a toast behind: its link, or a failure");

  await connect.locator(".provider", { hasText: "Kimi For Coding" }).first().locator(".provider-connect").click();
  await connect.click(".menu-item >> text=Sign in with Kimi Code");
  await connect.waitForSelector(".connect .connect-code >> text=WDJB-MJHT");
  await connect.keyboard.press("Escape");
  await connect.waitForSelector(".connect", { state: "detached" });

  await connect.fill("input[aria-label='Search providers']", "bedrock");
  await connect.locator(".provider", { hasText: "Amazon Bedrock" }).first().locator(".provider-connect").click();
  // Its first question is a choice: the way in is an AWS profile, which it documents, then asks for.
  await connect.click(".connect .connect-choice >> text=AWS profile");
  await connect.waitForSelector(".connect .connect-info >> text=AWS profiles");
  assert.equal(await connect.locator(".connect .connect-paste").count(), 0, "a documentation link made the question look like a sign-in page's fallback");
  // The profile named is the credential stored.
  await connect.fill(".connect .connect-question input", "default");
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
  await fields.nth(1).fill(bare.provider);
  await fields.nth(2).fill("m1");
  await fields.nth(3).fill("sk-gateway");
  await connect.click(".custom-provider >> text=Add provider");
  await connect.waitForSelector(".custom-provider", { state: "detached", timeout: 10_000 });
  assert.notEqual(await connect.evaluate(() => (window as any).sawConnect), true, "adding a custom provider with a key opened the connect dialog too");
  // One whose key the provider refuses (the scripted one refuses any with "wrong" in it): the connect dialog says why, and
  // takes another.
  await connect.locator(".provider", { hasText: "Custom provider" }).locator(".provider-connect").click();
  await connect.waitForSelector(".custom-provider-form");
  await fields.nth(0).fill("Proxy");
  await fields.nth(1).fill(bare.provider);
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
  const styled = await open(bare);
  styled.on("pageerror", (error) => errors.push(error.message));
  await styled.goto(`${url}/`);
  await settled(styled);
  await bare.plugins({
    "check-look.web.js": `export default ({ defineWebPlugin, contracts: { Slots, SidebarFooter, Themes, Accents, SettingsGroups, SectionIds }, html }) =>
      defineWebPlugin({ id: "check-look", requires: { slots: Slots }, setup: ({ slots }) => {
        window.lookSlots = slots;
        slots.add(SidebarFooter, { id: "check-utilities", order: 1, component: () => html\`<span class="check-utilities tw:p-0.5 tw:px-4 tw:bg-accent tw:rounded">styled</span>\` });
        slots.add(Themes, { id: "check-night", title: "Check night", scheme: "dark", colors: { bg: "rgb(10, 20, 30)" } });
        slots.add(Themes, { id: "check-day", title: "Check day", scheme: "light", colors: { bg: "rgb(250, 240, 220)" } });
        slots.add(Accents, { id: "check-teal", title: "Check teal", color: "rgb(0, 128, 128)" });
        slots.add(SettingsGroups, { id: "check-look", section: SectionIds.appearance, title: "Check", entries: () => [{ text: "check look", view: () => html\`<p class="check-look-row">a plugin's row</p>\` }] });
      } });`,
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
  await styled.click("[role=radiogroup][aria-label='Dark theme'] [role=radio][aria-label='Check night']");
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
  // A settings row is kept, not drawn again, when its group is asked for its rows again, as when the host answers a
  // pick, or here a plugin adds a group ahead of it, so what is open or focused in it stays: in its section and in a search.
  const keepsRow = async (where: string) => {
    await styled.waitForSelector("[role=radiogroup][aria-label='Light theme'] [role=radio]");
    await styled.evaluate(async () => {
      document.querySelector("[role=radiogroup][aria-label='Light theme'] [role=radio]")!.setAttribute("data-check-kept", "");
      const { SettingsGroups, SectionIds } = (await import("/src/ui/api.ts" as string)).api.contracts;
      (window as any).removeLookGroup = (window as any).lookSlots.add(SettingsGroups, {
        id: "check-recompute",
        section: SectionIds.appearance,
        order: 5,
        title: "Check again",
        entries: () => [{ text: "check again theme palette", view: () => document.createElement("p") }],
      });
    });
    await drawn(styled);
    assert.equal(await styled.locator("[role=radio][data-check-kept]").count(), 1, `a settings row was drawn again ${where}`);
    await styled.evaluate(() => (window as any).removeLookGroup());
    await drawn(styled);
  };
  await keepsRow("as its section's groups were asked again");
  await styled.click("[role=radiogroup][aria-label='Light theme'] [role=radio][aria-label='Check day']");
  await styled.waitForFunction(() => document.documentElement.style.getPropertyValue("--bg") === "rgb(250, 240, 220)", undefined, { timeout: 5_000 });
  const day = await styled.evaluate(async () => (await import("/src/ui/api.ts" as string)).api.look.tokenColor("--bg-raised"));
  const [red, , blue] = [1, 3, 5].map((at) => Number.parseInt(day.slice(at, at + 2), 16)) as [number, number, number];
  assert(day !== "#ffffff" && red - blue > 15, `a light theme's raised surface does not follow its background: ${day}`);
  await styled.fill("[aria-label='Search settings']", "light theme palette");
  await styled.waitForSelector(".settings-result [role=radiogroup][aria-label='Light theme']");
  await keepsRow("in a search result as its section's groups were asked again");
  await styled.fill("[aria-label='Search settings']", "");
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

  await bare.plugins({ "check-look.web.js": null });
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
  // A host whose config has no look yet, which the form's page shares after.
  const plain = await startHost({ threads: false, files: { "pull-request.js": PULL_REQUEST } });
  const carried = await open(plain);
  carried.on("pageerror", (error) => errors.push(error.message));
  await carried.addInitScript(() => {
    if (sessionStorage.getItem("check-carried") !== null) return;
    sessionStorage.setItem("check-carried", "1");
    localStorage.setItem("lemma.theme", "dark");
    localStorage.setItem("lemma.contentWidth", "full");
  });
  await carried.goto(`${url}/`);
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
  const form = await open(plain);
  form.on("pageerror", (error) => errors.push(error.message));
  await form.goto(`${url}/`);
  await settled(form);
  await form
    .waitForFunction(
      async () => {
        const { Commands } = (await import("/src/ui/api.ts" as string)).api.contracts;
        const commands = await (window as any).lemma.service(Commands);
        const command = commands.list().find((command: { readonly id: string }) => command.id === "pull-request.open");
        if (command !== undefined) void commands.run(command);
        return command !== undefined;
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => assert.fail("a plugin's command is not listed"));
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
  // A new thread in a git project can start in a new worktree, from the remote's version of its branch: the menu of where
  // to work chooses the worktree, the branch menu's switch the remote, which the branch says, and the first prompt makes
  // it, from the remote's `main`, a commit behind the project's.
  const forks = await startHost();
  const fork = await open(forks);
  fork.on("pageerror", (error) => errors.push(error.message));
  await fork.goto(`${url}/`);
  await fork.waitForSelector(".thread-chat.starting .thread-start [aria-label=Project]", { timeout: 10_000 });
  await fork.click(".thread-start [aria-label=Project]");
  await fork.click(".project-menu .menu-item >> text=lemma");
  await fork.click(".thread-start [aria-label='Where to work']");
  await fork.click(".where-menu .menu-item >> text=New worktree");
  await fork.click(".thread-start [aria-label='Worktree base branch']");
  await fork.click(".branch-menu .menu-toggle-row [role=switch]");
  await fork
    .waitForSelector(".thread-start [aria-label='Worktree base branch'] >> text=/from origin\\//", { timeout: 5_000 })
    .catch(() => assert.fail("a new worktree to start from the remote does not say so on its branch"));
  await fork.keyboard.press("Escape");
  await fork.fill("textarea", "work apart");
  await fork.keyboard.press("Enter");
  // The worktree made for the branch `lemma/work-apart`, once git lists it.
  const made = await eventually(async () =>
    git(forks.projects.lemma, "worktree", "list", "--porcelain")
      .split("\n\n")
      .flatMap((entry) => (entry.includes("branch refs/heads/lemma/work-apart") ? [/^worktree (.+)$/m.exec(entry)![1]!] : []))
      .at(0),
  );
  if (made === undefined) assert.fail("a new thread in a new worktree made none");
  assert.equal(
    git(made, "rev-parse", "HEAD"),
    git(forks.projects.lemma, "rev-parse", "origin/main"),
    "a new worktree to start from the remote started from the project's own branch",
  );
  // The worktree is a place in its project, never a project: its thread is the project's, and a new thread started from
  // it starts in the project, which offers the worktree to go on in.
  await fork.click(".main-head .card-toggle", { timeout: 10_000 });
  await fork
    .waitForSelector(".thread-card [aria-label=Worktree]", { timeout: 10_000 })
    .catch(() => assert.fail("a thread in a worktree does not say so in its card"));
  await fork.keyboard.press("ControlOrMeta+Shift+o");
  await fork.waitForSelector(".thread-chat.starting .thread-start [aria-label=Project] >> text=lemma", { timeout: 10_000 }).catch(() => {
    assert.fail("a new thread started from one in a worktree is not in the worktree's project");
  });
  await fork.click(".thread-start [aria-label=Project]");
  const projects = await fork.locator(".project-menu .menu-item .menu-label").allTextContents();
  assert.ok(!projects.some((name) => name.startsWith("lemma-")), `a worktree is listed as a project: ${projects.join(", ")}`);
  await fork.keyboard.press("Escape");
  await fork.click(".thread-start [aria-label='Where to work']");
  await fork
    .waitForSelector(".where-menu .where-list .menu-item >> text=lemma/work-apart", { timeout: 5_000 })
    .catch(() => assert.fail("the project does not offer its worktree to go on in"));
  await fork.keyboard.press("Escape");
  // A project deleted with the thread shown in it stays gone: the new thread the page lands on is not made there.
  await fork.click(".sidebar >> text=Landing page copy");
  await fork.keyboard.press("ControlOrMeta+,");
  await fork.click(".settings-nav >> text=Projects");
  await fork.click(".projects-list >> text=website");
  await fork.click(".settings button:has-text('Delete…')");
  await fork.click(".delete-project-dialog .button-danger");
  await fork.waitForSelector(".sidebar >> text=Landing page copy", { state: "detached", timeout: 5_000 });
  await fork.keyboard.press("Escape");
  await fork.waitForSelector(".thread-chat.starting .thread-start [aria-label=Project]", { timeout: 10_000 });
  await fork.click(".thread-start [aria-label=Project]");
  const left = await fork.locator(".project-menu .menu-item .menu-label").allTextContents();
  assert.ok(!left.includes("website"), `a deleted project came back with a new thread made in it: ${left.join(", ")}`);
  await fork.close();
  expectNoErrors("starting a new thread in a new worktree from the remote, and a new thread after it");

  // 13. Settings › Profiles, on the host's profiles: the default alone, as Core, the current one; one made in the
  // New profile dialog gets a row, renames in place, and goes only after its dialog asks; while there are two, the
  // settings button shows the profile this page is.
  const profiles = await open(forks);
  profiles.on("pageerror", (error) => errors.push(error.message));
  await profiles.goto(`${url}/settings/profiles`);
  const rows = profiles.locator(".settings .profiles-row");
  await rows
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => assert.fail("Settings › Profiles lists no profile"));
  assert.deepEqual(
    await rows.evaluateAll((all) => all.map((row) => [row.querySelector(".setting-title")?.textContent, row.querySelector(".setting-desc")?.textContent])),
    [["Core", "Current"]],
    "Settings › Profiles does not list the default alone, as Core, the current one",
  );
  await profiles.click(".settings-section-head button:has-text('New profile')");
  await profiles.fill(".profiles-dialog input[aria-label=Name]", "Work");
  await profiles.click(".profiles-dialog button[type=submit]");
  await profiles.waitForSelector(".profiles-dialog", { state: "detached", timeout: 5_000 }).catch(() => assert.fail("making a profile left its dialog open"));
  const work = rows.filter({ hasText: "Work" });
  await work
    .locator(".setting-desc", { hasText: "Stopped" })
    .waitFor({ timeout: 5_000 })
    .catch(() => assert.fail("a profile made in the New profile dialog has no row"));
  // Two profiles: the settings button, at the sidebar's foot once settings close, is this page's profile.
  await profiles.keyboard.press("Escape");
  await profiles
    .waitForSelector(".sidebar-foot .settings-trigger .profiles-avatar", { timeout: 5_000 })
    .catch(() => assert.fail("with two profiles, the settings button does not show the profile's face"));
  assert.match(
    (await profiles.locator(".sidebar-foot .settings-trigger").getAttribute("aria-label")) ?? "",
    /^Profile: Core · Settings/,
    "the settings button does not name the profile this page is",
  );
  // Back to Settings › Profiles.
  await profiles.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open("profiles");
  });
  // Renaming in place: Manage › Rename puts a field where the name was, and Enter keeps what is typed.
  await work.getByRole("button", { name: "Work options" }).click();
  await profiles.click(".popover [role=menuitem]:has-text('Rename')");
  // The row's name is the field's value now, which `hasText` does not read: the field is found among the rows.
  const field = rows.locator("input[aria-label='Rename Work']");
  await field.waitFor({ timeout: 5_000 }).catch(() => assert.fail("Rename does not put a field in the profile's row"));
  await field.fill("Day job");
  await field.press("Enter");
  const renamed = rows.filter({ hasText: "Day job" });
  await renamed.waitFor({ timeout: 5_000 }).catch(() => assert.fail("a profile renamed in place does not show its new name"));
  // Deleting asks in a dialog that says what goes; confirming takes its row.
  await renamed.getByRole("button", { name: "Day job options" }).click();
  await profiles.click(".popover [role=menuitem]:has-text('Delete')");
  const ask = profiles.locator(".profiles-dialog", { hasText: "Delete Day job?" });
  await ask.waitFor({ timeout: 5_000 }).catch(() => assert.fail("deleting a profile does not ask in a dialog"));
  assert.match((await ask.textContent()) ?? "", /threads, config, plugins, and logins go with it/, "the delete dialog does not say what goes with the profile");
  await ask.locator(".button-danger").click();
  await renamed.waitFor({ state: "detached", timeout: 5_000 }).catch(() => assert.fail("a profile deleted from its dialog keeps its row"));
  assert.equal(await rows.count(), 1, "deleting a profile took another's row");
  await profiles.close();
  expectNoErrors("making, renaming, and deleting a profile");

  return "a form question is drawn as settings are and answers its command; with no provider it opens in the chat, whose notice leads to Providers and back; providers connect each way in one dialog; a web half's Tailwind classes compile with the app's, from its tokens; a theme pack's theme, accent, and row come and go with it; an older app's appearance carries over; a new thread starts in a new worktree from the remote's branch when asked, files it under its project, and a new thread after it starts in the project; a project deleted under the thread shown stays gone; Settings › Profiles lists the default as Core, makes, renames, and deletes a profile, and the settings button shows its face while there are two";
};
