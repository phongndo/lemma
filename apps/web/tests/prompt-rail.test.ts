import { describe, expect, it } from "vitest";
import { cardTop, jumpOver, locate, tickAt, tickNear, tickScale } from "../src/model/prompt-rail.ts";

// Three turns starting at 0, 1000, and 2000 in a 3000px transcript, read through a 600px view.
const tops = [0, 1000, 2000];
const view = (top: number) => ({ top, height: 600, scrollHeight: 3000 });

describe("locate", () => {
  it("reads the last prompt whose turn starts above the top third, with the turns in view lit", () => {
    // Turn 1 starts below the view's top, so it is also where stepping forward goes.
    expect(locate(tops, view(900))).toEqual({ current: 1, seen: { first: 0, last: 1 }, previous: 0, next: 1 });
    // Its turn starts below the top third: the one before is still being read.
    expect(locate(tops, view(700))).toMatchObject({ current: 0, seen: { first: 0, last: 1 } });
  });

  it("reads the last prompt at the bottom, however short its turn, and offers no next", () => {
    expect(locate(tops, view(2400))).toEqual({ current: 2, seen: { first: 2, last: 2 }, previous: 2, next: undefined });
  });

  it("steps from where a jump is heading rather than where the view is", () => {
    expect(locate(tops, view(0), 992)).toMatchObject({ previous: 0, next: 2 });
  });

  it("skips prompts whose turns are not drawn", () => {
    expect(locate([0, undefined, 2000], view(900))).toMatchObject({ current: 0, next: 2 });
  });
});

describe("jumpOver", () => {
  it("ends a jump that arrived, passed its mark, or turned back", () => {
    expect(jumpOver(1000, 999, 500)).toBe(true);
    expect(jumpOver(1000, 1100, 500)).toBe(true);
    expect(jumpOver(1000, 400, 500)).toBe(true);
    expect(jumpOver(1000, 700, 500)).toBe(false);
  });
});

describe("ticks", () => {
  it("spaces ticks evenly and finds the nearest to a point on the rail", () => {
    expect([0, 1, 2].map((index) => tickAt(index, 3))).toEqual([0, 50, 100]);
    expect(tickAt(0, 1)).toBe(0);
    expect([0, 0.3, 0.8, 1.5].map((progress) => tickNear(progress, 3))).toEqual([0, 1, 2, 2]);
  });

  it("lengthens the tick pointed at and its neighbours", () => {
    expect([0, 1, 2, 3, 4].map((index) => tickScale(index, 2))).toEqual([0.417, 0.667, 1, 0.667, 0.417]);
    expect(tickScale(9, 2)).toBe(0.333);
    expect(tickScale(0, undefined)).toBe(0.333);
  });

  it("keeps the card level with its tick, inside the view", () => {
    const within = { top: 0, bottom: 500 };
    expect(cardTop(250, 100, within, 8)).toBe(200);
    expect(cardTop(10, 100, within, 8)).toBe(8);
    expect(cardTop(490, 100, within, 8)).toBe(392);
  });
});
