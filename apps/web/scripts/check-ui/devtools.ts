import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { atBlankThread, boot, drawn } from "./shared.ts";

// 8: the devtools.
export const devtools = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot(await startHost());

  // 8. The devtools: docked under the app, each panel shows the app as it runs, and every panel's data reads as JSON.
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
  // By phase: agent.modes chooses what a thread's mode allows, first among the `select` handlers, and
  // context.compaction, in `fit`, sizes what every other handler made, last.
  await page.waitForSelector("[aria-label='Hook details'] tr:has(td:text-is('1')):has(td:text-is('select · order 0')) >> button:text-is('agent.modes')");
  await page.waitForSelector("[aria-label='Hook details'] tbody tr:last-child:has(td:text-is('fit · order 0')) >> button:text-is('context.compaction')");
  // Registries: the web app's slots, live, with who fills each and how to add to it.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Registries");
  await page.fill("[aria-label='Filter registries']", "pages");
  await page.click("[aria-label=Registries] tr:has(td:first-child:text-is('pages'))");
  await page.waitForSelector("[aria-label='Registry items'] tr:has(td:text-is('thread-view.new')):has(button:text-is('threads.view'))");
  // A slot names the contract declaring it, from the contracts the runtime lists (`WebPlugins.contracts`).
  await page.waitForSelector("[aria-label='Registry details'] .dt-details-title >> text=Pages from @lemma/web");
  await page.fill("[aria-label='Filter registries']", "settings.sections");
  await page.click("[aria-label=Registries] tr:has(td:first-child:text-is('settings.sections'))");
  await page.waitForSelector("[aria-label='Registry details'] .dt-details-title >> text=SettingsSections from @lemma/settings");
  // Inspectors: what host plugins let you look into, as tables.
  await page.click("[aria-label='Devtools panels'] [role=tab] >> text=Inspectors");
  // Its title: the row's other cell links to the plugin, and where the row's middle falls depends on what else is listed.
  await page.click("[aria-label=Inspectors] tr:has-text('Tools') td:first-child");
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
  return "the devtools show routes, navigation, host events and streams, channels, plugins, hooks, registries, inspectors, and the traces, filtered, by plugin, and their changes";
};
