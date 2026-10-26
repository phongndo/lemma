import assert from "node:assert/strict";
import { startHost } from "./hosts.ts";
import { boot, drawn } from "./shared.ts";

// 10: the prompt rail.
export const rail = async (): Promise<string> => {
  const { page, expectNoErrors } = await boot(await startHost());

  // The api a web half receives: its contracts merge with no name exported by two of them (one would hide the other),
  // with no maker of slots and parts but the api's own, and with the thread routes.
  const contracts = await page.evaluate(async () => {
    const { api } = await import("/src/ui/api.ts" as string);
    const { contractModules } = await import("/src/ui/contracts.ts" as string);
    const owners: Record<string, string[]> = {};
    for (const [module, exports] of Object.entries(contractModules as Record<string, object>)) {
      for (const name of Object.keys(exports)) (owners[name] ??= []).push(module);
    }
    const all = api.contracts as Record<string, unknown>;
    return {
      shadowed: Object.entries(owners).filter(([, modules]) => modules.length > 1),
      makers: ["definePart", "createSlots"].filter((name) => all[name] !== undefined),
      routes: ["ThreadRoute", "NewThreadRoute"].filter((name) => all[name] !== undefined),
    };
  });
  assert.deepEqual(contracts.shadowed, [], "two contracts export one name, so api.contracts hides one");
  assert.deepEqual(contracts.makers, [], "api.contracts hands out a maker of slots or parts");
  assert.deepEqual(contracts.routes, ["ThreadRoute", "NewThreadRoute"], "api.contracts lacks the thread routes");

  // 10. The prompt rail: a tick per prompt; the card for the one pointed at is level with it, and a click goes there.
  // Each answered at length, so the chat scrolls through them.
  await page.evaluate(async () => {
    const { Settings } = (await import("/src/ui/api.ts" as string)).api.contracts;
    (await (window as any).lemma.service(Settings)).open(undefined);
  });
  for (const [index, prompt] of ["first prompt at length", "second prompt at length", "third prompt at length"].entries()) {
    await page.fill("textarea", prompt);
    await page.keyboard.press("Enter");
    await page.waitForFunction((count) => document.querySelectorAll(".turn-footer").length === count, index + 1, { timeout: 20_000 });
  }
  const ticks = page.locator("nav[aria-label='Prompts'] button.prompt-tick");
  assert.equal(await ticks.count(), 3, "the prompts landmark does not have a tick button per prompt");
  // The strip is level with the middle of the whole pane, the composer included, not just the chat above it.
  const offCenter = await page.evaluate(() => {
    const strip = document.querySelector(".prompt-strip")!.getBoundingClientRect();
    const head = document.querySelector(".main-head")!.getBoundingClientRect();
    const main = document.querySelector(".main")!.getBoundingClientRect();
    return Math.abs(strip.top + strip.height / 2 - (head.bottom + main.bottom) / 2);
  });
  assert.ok(offCenter <= 1, "the prompt rail is not level with the middle of the pane");
  // The transcript and the composer share the pane's middle, its scrollbar notwithstanding, with the sidebar open or closed.
  const middles = () =>
    page.evaluate(() =>
      [".main", ".turn", ".composer"].map((selector) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return (box.left + box.right) / 2;
      }),
    );
  for (const sidebar of ["open", "closed"]) {
    const [pane, turn, composer] = await middles();
    assert.ok(
      Math.abs(turn! - pane!) <= 1 && Math.abs(composer! - pane!) <= 1,
      `with the sidebar ${sidebar}, the transcript or composer is off the pane's middle`,
    );
    await page.keyboard.press("Control+b");
    await drawn(page);
  }
  // The transcript passes under the composer, and at its end, however tall the composer grows, the last turn clears it.
  const clearance = () =>
    page.evaluate(() => {
      const composer = document.querySelector(".composer")!.getBoundingClientRect();
      const scroller = document.querySelector(".chat-view .scroller")!.getBoundingClientRect();
      const turns = document.querySelectorAll(".turn");
      return { under: scroller.bottom - composer.top, clear: composer.top - turns[turns.length - 1]!.getBoundingClientRect().bottom };
    });
  const short = await clearance();
  assert.ok(short.under > 0 && short.clear >= 0, `the transcript does not pass under the composer and clear it at its end: ${JSON.stringify(short)}`);
  await page.fill("textarea", Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n"));
  await page
    .waitForFunction(
      () => {
        const composer = document.querySelector(".composer")!.getBoundingClientRect();
        const turns = document.querySelectorAll(".turn");
        return composer.top - turns[turns.length - 1]!.getBoundingClientRect().bottom >= 0;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("a taller composer covers the end of the transcript"));
  await page.fill("textarea", "");
  assert.deepEqual(
    await ticks.evaluateAll((all) => all.map((tick) => [tick.tabIndex, tick.getAttribute("aria-current")])),
    [
      [-1, null],
      [-1, null],
      [0, "location"],
    ],
    "the current prompt's tick is not the rail's one tab stop",
  );
  const point = async (index: number) => {
    const box = (await ticks.nth(index).boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
  };
  const cardShows = (text: string, failure: string) =>
    page.waitForSelector(`.prompt-card:has-text('${text}')`, { timeout: 5_000 }).catch(() => assert.fail(failure));
  /** The scroller's position once a smooth scroll stops. */
  const scrolled = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const scroller = document.querySelector(".chat-view .scroller")!;
          let last = -1;
          let still = 0;
          const frame = () => {
            still = scroller.scrollTop === last ? still + 1 : 0;
            last = scroller.scrollTop;
            if (still >= 10) resolve(last);
            else requestAnimationFrame(frame);
          };
          frame();
        }),
    );
  await point(1);
  await cardShows("second prompt", "pointing at a tick does not show its prompt");
  const [tick, card] = await page.evaluate(() =>
    [".prompt-tick.pointed", ".prompt-card"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return (box.top + box.bottom) / 2;
    }),
  );
  assert(Math.abs(tick! - card!) < 1, `the prompt card's middle is at ${card}, not level with its tick at ${tick}`);
  // From the bottom, the previous and next buttons (reached from the strip) move the view a turn each time.
  const step = async (which: "previous" | "next") => {
    const strip = (await page.locator(".prompt-hit").boundingBox())!;
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
    const button = (await page.locator(`.prompt-step.${which}`).boundingBox())!;
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    return scrolled();
  };
  const bottom = await scrolled();
  const up = await step("previous");
  const further = await step("previous");
  const down = await step("next");
  assert(up < bottom - 10 && further < up - 10 && down > further + 10, `stepping through prompts went ${bottom} → ${up} → ${further} → ${down}`);
  await point(0);
  await page.mouse.down();
  await page.mouse.up();
  const atFirst = await scrolled();
  const [turnTop, ...lit] = await page.evaluate(() => [
    document.querySelector<HTMLElement>(".turn")!.offsetTop,
    ...[...document.querySelectorAll(".prompt-tick")].map((element) => element.classList.contains("seen")),
  ]);
  assert(
    Math.abs(atFirst - (Number(turnTop) - 8)) < 2 && lit[0] === true && lit[2] === false,
    `clicking the first prompt's tick went to ${atFirst} (its turn is at ${turnTop}), lighting ${lit}`,
  );
  // The keys move along the ticks; pointing elsewhere and away gives the card back to the focused one, and Enter goes there.
  await page.mouse.move(900, 450);
  await page.focus(".prompt-tick[tabindex='0']");
  await page.keyboard.press("End");
  await cardShows("third prompt", "the keys do not choose a prompt on the rail");
  // A key with a modifier is left to the app's shortcuts.
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Prompt 3 of 3: third prompt at length",
    "the rail took a modified key",
  );
  await point(0);
  await cardShows("first prompt", "pointing at a tick while another is focused does not show it");
  await page.mouse.move(900, 450);
  await cardShows("third prompt", "the focused tick's card did not return when the pointer left");
  await page.keyboard.press("Enter");
  assert((await scrolled()) > atFirst + 10, "Enter on a focused tick does not go to its prompt");
  // With short last turns (their replies hidden), the view cannot reach their starts: Previous still goes up from the bottom.
  await page.addStyleTag({ content: ".turn:nth-of-type(n + 2) > :not(:first-child) { display: none }" });
  await page.evaluate(() => {
    const scroller = document.querySelector(".chat-view .scroller")!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  const end = await scrolled();
  const back = await step("previous");
  const forth = await step("next");
  assert(back < end - 10 && forth > back + 10, `stepping past short turns went ${end} → ${back} → ${forth}`);
  // The width setting moves the text without resizing the window: the strip moves aside and stays clear of it.
  await page.evaluate(() => document.documentElement.style.setProperty("--content", "none"));
  await page
    .waitForFunction(
      () => {
        const content = document.querySelector(".chat-view .content")!;
        const text = content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft);
        return document.querySelector(".prompt-hit")!.getBoundingClientRect().right <= text - 8 && document.querySelector(".prompt-rail.tucked") !== null;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => assert.fail("the prompt rail's strip covers the text once the content is wider"));
  await page.evaluate(() => document.documentElement.style.removeProperty("--content"));
  expectNoErrors("using the prompt rail");
  return "the prompt rail previews a prompt level with its tick and goes to it";
};
