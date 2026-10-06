import { describe, expect, it } from "vitest";
import { ledger, trajectory } from "@lemma/contracts";
import type { EventData, LedgerSpan } from "@lemma/contracts";
import { GAP, ledgerStats, panned, place, ticks, timeScale, ttftPercent, wheeled } from "../src/model/timeline.ts";
import { assistant, usage, user } from "./fixtures.ts";

/** Spans for `turns`, each a list of [start, end] model calls (no end: still running). */
const spansOf = (...turns: readonly (readonly (readonly [number, number?])[])[]): LedgerSpan[] =>
  turns.flatMap((calls, t) =>
    calls.map(([start, end]): LedgerSpan => ({
      record: { turn: { turnId: `t${t}` } } as LedgerSpan["record"],
      lane: 1,
      start,
      ...(end === undefined ? {} : { end }),
      error: false,
    })),
  );

describe("timeScale", () => {
  it("lays turns out by their active time, collapsing the idle time between them to a gap", () => {
    // Two turns of 1s each, an hour apart.
    const scale = timeScale(spansOf([[0, 1000]], [[3_600_000, 3_601_000]]), 0);
    const usable = 1 - GAP;
    expect(scale.fraction(0)).toBe(0);
    expect(scale.fraction(1000)).toBeCloseTo(usable / 2);
    expect(scale.fraction(3_600_000)).toBeCloseTo(GAP + usable / 2);
    expect(scale.fraction(3_601_000)).toBeCloseTo(1);
    expect(scale.boundaries).toEqual([expect.closeTo(GAP / 2 + usable / 2)]);
    expect(scale.msPerFraction).toBeCloseTo(2000 / usable);
    // Back from fractions to times, inside each turn.
    expect(scale.timeAt(usable / 4)).toBeCloseTo(500);
    expect(scale.timeAt(GAP + (usable * 3) / 4)).toBeCloseTo(3_600_500);
  });

  it("runs a span still going up to now, and is empty without spans", () => {
    expect(timeScale(spansOf([[0]]), 400).fraction(400)).toBe(1);
    expect(timeScale([], 0)).toMatchObject({ empty: true });
  });
});

describe("zoom", () => {
  it("places a fraction in a box showing part of the axis", () => {
    expect(place(0.5, { start: 0.25, end: 0.75 }, 200)).toBe(100);
  });

  it("pans by part of its width and stays on the axis", () => {
    expect(panned({ start: 0.2, end: 0.4 }, 0.5)).toEqual({ start: expect.closeTo(0.3), end: expect.closeTo(0.5) });
    expect(panned({ start: 0.7, end: 0.9 }, 5)).toEqual({ start: expect.closeTo(0.8), end: expect.closeTo(1) });
  });

  it("zooms around the pointer on a vertical wheel and pans on a horizontal one", () => {
    const zoomedIn = wheeled({ start: 0, end: 1 }, { deltaX: 0, deltaY: -400 }, 50, 100);
    expect(zoomedIn.end - zoomedIn.start).toBeLessThan(1);
    // The point under the pointer stays under it.
    expect(zoomedIn.start + 0.5 * (zoomedIn.end - zoomedIn.start)).toBeCloseTo(0.5);
    expect(wheeled({ start: 0.2, end: 0.4 }, { deltaX: 50, deltaY: 0 }, 0, 100)).toEqual(panned({ start: 0.2, end: 0.4 }, 0.5));
    // Never closer than 0.2% of the axis.
    expect(wheeled({ start: 0.5, end: 0.501 }, { deltaX: 0, deltaY: -10_000 }, 50, 100).end).toBeCloseTo(0.502);
  });
});

describe("ticks", () => {
  it("marks a round amount of active time about every 90px", () => {
    // 10s across 900px: a tick per second.
    const marks = ticks({ start: 0, end: 1 }, 10_000, 900);
    expect(marks.map((tick) => tick.ms)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000].map((ms) => expect.closeTo(ms)));
  });
});

describe("ttftPercent", () => {
  it("is how far into a finished call its first token came", () => {
    const [span] = spansOf([[0, 2000]]);
    expect(ttftPercent({ ...span!, ttft: 500 })).toBe(25);
    expect(ttftPercent(span!)).toBeUndefined();
    expect(ttftPercent({ ...spansOf([[0]])[0]!, ttft: 500 })).toBeUndefined();
  });
});

describe("ledgerStats", () => {
  it("adds up requests, tool calls, failures, tokens with the cache counted as input, and cost", () => {
    const events: EventData[] = [
      { type: "turn-start", turnId: "t" },
      user("go", "t"),
      { type: "step-start", turnId: "t", stepId: "s" },
      { type: "message", turnId: "t", stepId: "s", message: assistant([{ type: "text", text: "ok" }], { usage: { ...usage(100, 20, 0.5), cacheRead: 50 } }) },
      { type: "step-end", turnId: "t", stepId: "s" },
      { type: "turn-end", turnId: "t", reason: "done" },
    ];
    const branch = events.map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: 1000 + i * 1000, data }));
    const records = ledger(trajectory(branch));
    expect(ledgerStats(records, 0)).toEqual({ requests: 1, tools: 0, errors: 0, input: 150, output: 20, cost: 0.5, active: 5000 });
  });
});
