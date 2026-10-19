import { describe, expect, it } from "vitest";
import { AUTO_MAX_HEIGHT, INITIAL_HEIGHT, SHRINK_MS, frameHeight, openable, pageOf } from "../src/page.ts";

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
});
