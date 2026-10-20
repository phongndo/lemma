import { describe, expect, it } from "vitest";
import {
  AUTO_MAX_HEIGHT,
  INITIAL_HEIGHT,
  REMEMBERED_PAGES,
  REMEMBERED_TABS,
  SETTLE_MS,
  SHRINK_MS,
  assignTab,
  frameHeight,
  isRememberedHeights,
  mergeHeights,
  openable,
  pageOf,
  recallHeight,
  rememberHeight,
} from "../src/page.ts";
import type { RememberedHeights } from "../src/page.ts";

describe("pageOf", () => {
  it("reads the page a result's details hold, and nothing from one that holds none", () => {
    expect(pageOf({ title: "T", html: "<p></p>", height: 200, missingImages: ["/a.png", 3] })).toEqual({
      title: "T",
      html: "<p></p>",
      height: 200,
      missingImages: ["/a.png"],
    });
    expect(pageOf({ title: "T", html: "<p></p>" })).toEqual({ title: "T", html: "<p></p>", missingImages: [] });
    expect(pageOf(undefined)).toBeUndefined();
    expect(pageOf({ title: "T" })).toBeUndefined();
    expect(pageOf({ title: "T", html: "<p></p>", height: Number.NaN })).toEqual({ title: "T", html: "<p></p>", missingImages: [] });
  });
});

describe("openable", () => {
  it("opens web links and email, never a script or a data URL", () => {
    expect(openable("https://example.com/a")).toBe(true);
    expect(openable("http://localhost:5173")).toBe(true);
    expect(openable("mailto:a@example.com")).toBe(true);
    expect(openable("javascript:alert(1)")).toBe(false);
    expect(openable("data:text/html,<p></p>")).toBe(false);
    expect(openable(undefined)).toBe(false);
  });
});

describe("a page's frame height", () => {
  it("fits the page, up to the model's cap or the automatic most, shrinking once a smaller height stands", () => {
    const fit = frameHeight();
    expect(fit.height).toBe(INITIAL_HEIGHT);
    expect(fit.report(21.2, 0)).toBe(INITIAL_HEIGHT);
    expect(fit.shrinking).toBe(true);
    expect(fit.settle(SHRINK_MS - 1)).toBe(INITIAL_HEIGHT);
    expect(fit.settle(SHRINK_MS)).toBe(22);
    expect(fit.shrinking).toBe(false);
    expect(fit.report(9000, 1000)).toBe(AUTO_MAX_HEIGHT);
    const capped = frameHeight(200);
    expect(capped.height).toBe(200);
    expect(capped.report(1000, 0)).toBe(200);
    capped.report(50, 1000);
    expect(capped.settle(1000 + SHRINK_MS)).toBe(50);
  });

  it("ignores a page not laid out yet, or hidden, which reports 0", () => {
    const fit = frameHeight();
    expect(fit.report(0, 0)).toBe(INITIAL_HEIGHT);
    expect(fit.shrinking).toBe(false);
    expect(fit.report(300, 10)).toBe(300);
    expect(fit.report(0, 20)).toBe(300);
    expect(fit.report(Number.NaN, 30)).toBe(300);
    expect(fit.settle(1000)).toBe(300);
  });

  it("stays put for a page sized by its frame (100vh), which reports the frame's height", () => {
    const fit = frameHeight();
    expect(fit.report(INITIAL_HEIGHT, 0)).toBe(INITIAL_HEIGHT);
    expect(fit.report(INITIAL_HEIGHT, 16)).toBe(INITIAL_HEIGHT);
    expect(fit.shrinking).toBe(false);
  });

  it("does not shake with a page whose heights go up and down as its frame's new size reaches it", () => {
    const fit = frameHeight();
    let now = 0;
    // min-height: 100vh and 20px more: each growth answered a frame later by a smaller height, then a larger one.
    const seen = [180, 145, 200, 165, 220, 185, 240, 205, 260].map((reported) => fit.report(reported, (now += 16)));
    expect(seen).toEqual([180, 180, 200, 200, 200, 200, 200, 200, 200]);
    // Smaller heights never stood long enough to take: none came after the last larger one.
    expect(fit.settle(now + 1)).toBe(200);
  });

  it("stops growing with a page that overflows each new height by the same amount, until it fits", () => {
    const fit = frameHeight();
    let now = 0;
    expect(fit.report(180, now)).toBe(180);
    expect(fit.report(200, (now += 16))).toBe(200);
    expect(fit.report(220, (now += 16))).toBe(200);
    expect(fit.report(240, (now += 16))).toBe(200);
    fit.report(120, (now += 16));
    expect(fit.settle(now + SHRINK_MS)).toBe(120);
    expect(fit.report(400, now + 1000)).toBe(400);
  });

  it("follows a page that grows by the same steps over time, as rows arriving do", () => {
    const fit = frameHeight();
    let now = 0;
    for (const reported of [180, 200, 220, 240, 260]) expect(fit.report(reported, (now += 500))).toBe(reported);
  });

  it("starts at the height it took before, within its cap, until the page says its own", () => {
    const fit = frameHeight();
    expect(fit.guess(640.2)).toBe(641);
    // The page, part-parsed, says less for a moment and then its whole height: the frame never moves.
    expect(fit.report(300, 0)).toBe(641);
    expect(fit.report(641, 50)).toBe(641);
    expect(fit.settle(1000)).toBe(641);
    // Once the page has said its height, a guess is too late to change it.
    expect(fit.guess(900)).toBe(641);
    expect(frameHeight(200).guess(640)).toBe(200);
    expect(frameHeight().guess(9000)).toBe(AUTO_MAX_HEIGHT);
    expect(frameHeight().guess(0)).toBe(INITIAL_HEIGHT);
  });

  it("settles at the height the page asked for once it has stood, and not before it has said any", () => {
    const guessed = frameHeight();
    guessed.guess(640);
    expect(guessed.settled(10_000)).toBe(false);
    // The page asks for the height the frame started at: nothing changed for it to answer.
    guessed.report(640, 0);
    expect(guessed.settled(0)).toBe(true);
    const fit = frameHeight();
    fit.report(640, 0);
    expect(fit.settled(SETTLE_MS - 1)).toBe(false);
    expect(fit.settled(SETTLE_MS)).toBe(true);
    // Shrinking waits: nothing is settled until the smaller height stands.
    fit.report(500, 1000);
    expect(fit.settled(1000 + SETTLE_MS)).toBe(false);
    fit.settle(1000 + SHRINK_MS);
    expect(fit.settled(1000 + SHRINK_MS + SETTLE_MS)).toBe(true);
  });

  it("never settles for a page sized by its frame, so it starts no taller the next time", () => {
    // min-height: 100vh and 32px more: each height the frame takes, the page answers with 32px more.
    let remembered: number | undefined;
    for (let draw = 0; draw < 3; draw++) {
      const fit = frameHeight();
      if (remembered !== undefined) fit.guess(remembered);
      let now = 0;
      for (let round = 0; round < 6; round++) fit.report(fit.height + 32, (now += 16));
      if (fit.settled(now + SETTLE_MS)) remembered = fit.height;
      expect(fit.height).toBe(INITIAL_HEIGHT + 64);
    }
    expect(remembered).toBeUndefined();
  });
});

describe("the heights frames took", () => {
  it("recalls a page's height at its width, else at the nearest width it was drawn at", () => {
    let heights: RememberedHeights = [];
    heights = rememberHeight(heights, "a", 728.4, 600);
    heights = rememberHeight(heights, "a", 390, 900);
    heights = rememberHeight(heights, "b", 728, 300);
    expect(recallHeight(heights, "a", 728)).toBe(600);
    expect(recallHeight(heights, "a", 400)).toBe(900);
    expect(recallHeight(heights, "a", 1000)).toBe(600);
    expect(recallHeight(heights, "c", 728)).toBeUndefined();
    // A width seen again takes its new height; the page seen last goes last.
    heights = rememberHeight(heights, "a", 728, 650);
    expect(recallHeight(heights, "a", 728)).toBe(650);
    expect(heights.map((page) => page.key)).toEqual(["b", "a"]);
    expect(rememberHeight(heights, "a", 728, 650)).toBe(heights);
    expect(isRememberedHeights(JSON.parse(JSON.stringify(heights)))).toBe(true);
    expect(isRememberedHeights([{ key: "a", sizes: [[728, "600"]] }])).toBe(false);
  });

  it("keeps a few widths of each page, and the pages seen last", () => {
    let heights: RememberedHeights = [];
    for (const width of [320, 390, 728, 860, 1000]) heights = rememberHeight(heights, "a", width, width);
    expect(heights[0]?.sizes.map(([width]) => width)).toEqual([390, 728, 860, 1000]);
    for (let page = 0; page <= REMEMBERED_PAGES; page++) heights = rememberHeight(heights, `p${page}`, 728, page);
    expect(heights).toHaveLength(REMEMBERED_PAGES);
    expect(recallHeight(heights, "a", 728)).toBeUndefined();
    expect(recallHeight(heights, `p${REMEMBERED_PAGES}`, 728)).toBe(REMEMBERED_PAGES);
  });
});

describe("what windows store", () => {
  it("lays one window's heights over what another stored since, keeping both", () => {
    const stored: RememberedHeights = rememberHeight(rememberHeight([], "a", 728, 600), "b", 728, 300);
    const merged = mergeHeights(stored, [
      ["c", 728, 400],
      ["a", 390, 900],
    ]);
    expect(recallHeight(merged, "a", 728)).toBe(600);
    expect(recallHeight(merged, "a", 390)).toBe(900);
    expect(recallHeight(merged, "b", 728)).toBe(300);
    expect(recallHeight(merged, "c", 728)).toBe(400);
  });

  it("names a tab's page over the tabs stored, the tab named last kept longest", () => {
    expect(assignTab({ t1: "a", t2: "b" }, "t1", "c")).toEqual({ t2: "b", t1: "c" });
    let tabs = {};
    for (let tab = 0; tab <= REMEMBERED_TABS; tab++) tabs = assignTab(tabs, `t${tab}`, "a");
    expect(Object.keys(tabs)).toHaveLength(REMEMBERED_TABS);
    expect(tabs).not.toHaveProperty("t0");
  });
});
