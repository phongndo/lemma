import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { atBlankThread, boot, checkPlugin, expose, showView } from "./shared.ts";

// 7: the threads down the sidebar: archived, blank, in the background, drafts, pinned and moved, waiting, searched, and in a project added.
export const sidebar = async (): Promise<string> => {
  const host = await startHost();
  const { page, expectNoErrors } = await boot(host);
  const where = () => page.evaluate(() => `${location.pathname}${location.search}`);
  // A seeded thread, opened from its row.
  await page.click(".thread-open:has-text('Fix flaky session log test')");
  await page.waitForSelector(".turn");
  const thread = await where();
  const seeded = thread.split("/")[2]!;

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
  await page.click(`[data-section=archived] [data-session-row][href="/threads/${seeded}"]`);
  await page
    .waitForFunction((id) => location.pathname === `/threads/${id}`, seeded, { timeout: 5_000 })
    .catch(async () => assert.fail(`opening an archived thread from the sidebar ended on ${await where()}`));
  await page.click(".archived-head");
  // Settings › Archived lists it too: its title opens it, and Unarchive on its row brings it back.
  const archivedRow = `.archived-row:has(a[href="/threads/${seeded}"])`;
  const openArchived = () =>
    page.evaluate(async () => {
      const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
      (await (window as any).lemma.service(Settings)).open("archived");
    });
  await openArchived();
  await page.click(`${archivedRow} .archived-title`);
  await page
    .waitForFunction((id) => location.pathname === `/threads/${id}`, seeded, { timeout: 5_000 })
    .catch(async () => assert.fail(`opening an archived thread from Settings › Archived ended on ${await where()}`));
  await openArchived();
  await page.hover(archivedRow);
  await page.click(`${archivedRow} button[aria-label^=Unarchive]`);
  await page
    .waitForSelector(archivedRow, { state: "detached", timeout: 5_000 })
    .catch(() => assert.fail("a thread unarchived from Settings › Archived is still listed there"));
  await archive(false);
  await page.evaluate(async (id) => {
    const { Threads } = (await import("/src/ui/api.ts" as string)).api.contracts;
    void (await (window as any).lemma.service(Threads)).select(id);
  }, seeded);
  await page.waitForFunction((id) => location.pathname === `/threads/${id}`, seeded);
  await page.waitForSelector(".turn");
  // Unarchived while shown, the thread is listed again.
  const listedRow = (id: string) => `.thread-section.sorted li:not([data-section=archived]) [data-session-row][href="/threads/${id}"]`;
  await page.waitForSelector(listedRow(seeded));
  // Archived from under the pointer, it goes below among the archived and the next thread shows; unarchived from there,
  // it is on top again.
  const listed = () =>
    page.$$eval(".thread-section.sorted li:not([data-section=archived]) [data-session-row]", (rows) =>
      rows.map((row) => new URL(row.getAttribute("href")!, "http://x").pathname),
    );
  await page.hover(listedRow(seeded));
  await page.click(`.thread-row:has([data-session-row][href="/threads/${seeded}"]) .thread-archive`);
  await page
    .waitForFunction((id) => !location.pathname.endsWith(id), seeded, { timeout: 5_000 })
    .catch(async () => assert.fail(`archiving the thread shown stayed on ${await where()}`));
  await page
    .waitForFunction(
      (id) =>
        ![...document.querySelectorAll(".thread-section.sorted li:not([data-section=archived]) [data-session-row]")].some(
          (row) => row.getAttribute("href") === `/threads/${id}`,
        ),
      seeded,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("an archived thread stayed among the active"));
  await page.click(".archived-head");
  await page.hover(`[data-section=archived] [data-session-row][href="/threads/${seeded}"]`);
  await page.click(`[data-section=archived] .thread-row:has([data-session-row][href="/threads/${seeded}"]) .thread-archive`);
  await page
    .waitForFunction(
      (id) => document.querySelector(".thread-section.sorted li:not([data-section=archived]) [data-session-row]")?.getAttribute("href") === `/threads/${id}`,
      seeded,
      {
        timeout: 5_000,
      },
    )
    .catch(async () => assert.fail(`an unarchived thread is not on top: ${(await listed()).join(", ")}`));
  // Nothing archived, the open fold stays and says so; closed again, it stays too.
  await page
    .waitForSelector(".archived-panel.open .archived-panel-empty", { timeout: 5_000 })
    .catch(() => assert.fail("with nothing archived, the open archived fold is gone or does not say so"));
  await page.click(".archived-head");
  await page
    .waitForSelector(".archived-head[aria-expanded=false]", { timeout: 5_000 })
    .catch(() => assert.fail("with nothing archived, the closed archived fold is gone"));
  await page.click(`.thread-list a[href="${thread}"]`);
  await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 });
  // A new thread is a session at once, not listed until it has a prompt; asked for again while it shows, it is the same
  // one; left with nothing written in it, it goes, as a tab closed does.
  await page.keyboard.press("ControlOrMeta+Shift+KeyO");
  await atBlankThread(page);
  const blankId = new URL(page.url()).pathname.split("/")[2]!;
  assert.equal(await page.locator(`.thread-list [href="/threads/${blankId}"]`).count(), 0, "a thread with nothing sent is listed");
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
  // Its answer held after its first words, so it is still at work when its card is measured below.
  host.mock.hold();
  await page.keyboard.press("ControlOrMeta+Enter");
  const background: string = await page
    .waitForFunction((known) => (window as any).blankThreads.list().find((session: any) => !known.includes(session.id))?.id, known, { timeout: 5_000 })
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(async () => assert.fail(`⌘Enter started no thread; ${JSON.stringify(await threadIds())}`));
  await page.waitForSelector(`.thread-list a[href="/threads/${background}"]`);
  // A card at work is as tall as one at rest, and stays so under the pointer: what it shows never changes its size, so
  // a pointer resting at its foot does not leave and find it again, over and over.
  const workingRow = `.thread-section.sorted .thread-row:has([data-session-row][href="/threads/${background}"])`;
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
  host.mock.release();
  assert.equal(await where(), thread, "⌘Enter left the thread shown");
  assert.equal(await page.inputValue("textarea"), "", "⌘Enter left the prompt in the composer");
  // Done while another showed, the background thread needs the person: Alt+Shift+↓ goes to it, though not from the
  // prompt, where it stays the field's, and the browser's back and forward (⌘[ and ⌘] in the desktop app) return. ⌘⌥A
  // archives it, and on it archived, unarchives it.
  await page
    .waitForSelector(`${workingRow} .thread-state[data-state=done]`, { timeout: 5_000 })
    .catch(() => assert.fail("a thread done in the background does not say so on its card"));
  const atBackground = (key: string) =>
    page
      .waitForFunction((id) => location.pathname === `/threads/${id}`, background, { timeout: 5_000 })
      .catch(async () => assert.fail(`${key} went to ${await where()}, not the thread done in the background`));
  const atThread = (key: string) =>
    page
      .waitForFunction((path) => `${location.pathname}${location.search}` === path, thread, { timeout: 5_000 })
      .catch(async () => assert.fail(`${key} went to ${await where()}, not ${thread}`));
  await page.focus("textarea");
  // In the prompt it is the text field's: no binding takes it (one would at once, before any move lands).
  await page.evaluate(() => {
    (window as any).taken = undefined;
    // The arrow's own keydown, after the modifiers' (Alt, then Shift, each a keydown of its own).
    window.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") (window as any).taken = event.defaultPrevented;
    });
  });
  await page.keyboard.press("Alt+Shift+ArrowDown");
  assert.equal(await page.evaluate(() => (window as any).taken), false, "Alt+Shift+↓ in the prompt was taken from it");
  await page.locator("textarea").blur();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await atBackground("Alt+Shift+↓");
  await page.goBack();
  await atThread("back");
  await page.goForward();
  await atBackground("forward");
  // The palette's Go back and Go forward, which the desktop app binds to keys: forward is offered only with somewhere ahead.
  const palette = async (title: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.fill(".palette-input input", title);
  };
  await palette("Go forward");
  assert.equal(await page.locator(".palette-row >> text=Go forward").count(), 0, "Go forward is offered with nothing ahead");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await palette("Go back");
  await page.waitForSelector(".palette-row >> text=Go back", { timeout: 5_000 });
  await page.keyboard.press("Enter");
  await atThread("Go back");
  await palette("Go forward");
  await page.waitForSelector(".palette-row >> text=Go forward", { timeout: 5_000 }).catch(() => assert.fail("Go forward is not offered after going back"));
  await page.keyboard.press("Enter");
  await atBackground("Go forward");
  await page.keyboard.press("ControlOrMeta+Alt+KeyA");
  await page
    .waitForFunction((id) => (window as any).blankThreads.list().find((session: any) => session.id === id)?.archived === true, background, { timeout: 5_000 })
    .catch(() => assert.fail("⌘⌥A did not archive the thread shown"));
  await page.goBack();
  await atBackground("back after archiving");
  await page.keyboard.press("ControlOrMeta+Alt+KeyA");
  await page
    .waitForFunction((id) => (window as any).blankThreads.list().find((session: any) => session.id === id)?.archived !== true, background, { timeout: 5_000 })
    .catch(() => assert.fail("⌘⌥A did not unarchive the archived thread shown"));
  await page.click(`.thread-list a[href="${thread}"]`);
  await atThread("a click");
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
  const draftRow = `.drafts [data-session-row][href="/threads/${draftId}"]`;
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
  const rowOf = (id: string) => `.thread-section.sorted .thread-row:has([data-session-row][href="/threads/${id}"])`;
  const before = await sorted();
  const pinning = before.at(-1)!;
  await page.hover(rowOf(pinning));
  await page.click(`${rowOf(pinning)} [aria-label^="Pin "]`);
  await page
    .waitForFunction((id) => document.querySelector(".thread-section.sorted [data-session-row]")?.getAttribute("href") === `/threads/${id}`, pinning, {
      timeout: 5_000,
    })
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
  // The sidebar's head: the toggle, and across from it the palette, search, and a new thread.
  assert.deepEqual(
    await page.$$eval(".sidebar-head button", (buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ["Toggle sidebar", "Command palette", "Search threads", "New thread"],
    "the sidebar's head is not the toggle, the palette, search, and a new thread",
  );
  // Its palette button opens the palette with nothing typed.
  await page.click(".sidebar-head [aria-label='Command palette']");
  await page.waitForFunction(() => (document.querySelector(".palette input") as HTMLInputElement | null)?.value === "", undefined, { timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".palette input", { state: "detached" });
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
  // Search floats: the head's button opens the palette's threads, whose search finds what was said in them too.
  await page.click(".sidebar-head [aria-label='Search threads']");
  await page
    .waitForSelector(".palette-input input[placeholder='Threads']", { timeout: 5_000 })
    .catch(() => assert.fail("Search does not open the palette's threads"));
  await page.keyboard.type("repair fetch");
  await page
    .waitForSelector(".palette-section:has-text('In messages') + .palette-row", { timeout: 5_000 })
    .catch(() => assert.fail("searching threads does not find what was said in them"));
  // Escape clears the search, goes back to the top level, then closes.
  await page.keyboard.press("Escape");
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
  assert.equal(
    await page.evaluate(() => (window as any).blankThreads.active().cwd.replace(/\/$/, "")),
    host.projects.lemma,
    "Enter in a folder gone into opened another",
  );
  expectNoErrors("using the threads down the sidebar");
  return "threads archive and unarchive from the sidebar and Settings; a blank thread goes unless kept; one run in the background says when it is done, and the keys go to it; a draft is held; a pinned thread moves; a waiting thread says so; search finds what was said; a project is added";
};
