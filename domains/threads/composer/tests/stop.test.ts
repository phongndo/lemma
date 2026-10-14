import { describe, expect, test } from "vitest";
import { STOP_WINDOW_MS, createStopKey } from "../src/stop.ts";
import type { StopWith } from "../src/stop.ts";

/** A stop key on a fake timer: `fire` closes the window as the timer would. */
const harness = (mode: StopWith = "escape-twice") => {
  let armed = false;
  let cancels = 0;
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const key = createStopKey({
    mode: () => mode,
    cancel: () => void cancels++,
    after: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    armed: () => armed,
    setArmed: (next) => void (armed = next),
  });
  return {
    key,
    armed: () => armed,
    cancels: () => cancels,
    timers,
    fire: () => timers.filter((timer) => !timer.cancelled).forEach((timer) => timer.fn()),
  };
};

describe("createStopKey", () => {
  test("escape-twice: the first press arms it for the window, the second stops the turn", () => {
    const h = harness();
    h.key.press();
    expect(h.armed()).toBe(true);
    expect(h.cancels()).toBe(0);
    expect(h.timers.map((timer) => timer.ms)).toEqual([STOP_WINDOW_MS]);
    h.key.press();
    expect(h.cancels()).toBe(1);
    expect(h.armed()).toBe(false);
    expect(h.timers[0]!.cancelled).toBe(true);
  });

  test("escape-twice: once the window closes, the next press arms it again", () => {
    const h = harness();
    h.key.press();
    h.fire();
    expect(h.armed()).toBe(false);
    h.key.press();
    expect(h.cancels()).toBe(0);
    expect(h.armed()).toBe(true);
  });

  test("escape: one press stops the turn", () => {
    const h = harness("escape");
    h.key.press();
    expect(h.cancels()).toBe(1);
    expect(h.armed()).toBe(false);
    expect(h.timers).toEqual([]);
  });

  test("a key held down (repeat) does nothing, so it cannot be both presses", () => {
    const h = harness();
    h.key.press();
    h.key.press(true);
    expect(h.cancels()).toBe(0);
    expect(h.armed()).toBe(true);
  });

  test("disarm (another thread, the turn ended) forgets a first press and its timer", () => {
    const h = harness();
    h.key.press();
    h.key.disarm();
    expect(h.armed()).toBe(false);
    expect(h.timers[0]!.cancelled).toBe(true);
    h.key.press();
    expect(h.cancels()).toBe(0);
  });
});
