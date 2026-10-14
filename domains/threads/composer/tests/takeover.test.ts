import { describe, expect, test } from "vitest";
import { holds, noChoices, release, take } from "../src/takeover.ts";

describe("takeover rules", () => {
  test("a takeover holds the box while the person has no prompt of their own unsent", () => {
    expect(holds(noChoices, "q1", false)).toBe(true);
    expect(holds(noChoices, "q1", true)).toBe(false);
  });

  test("let go, it holds the box no more, until taken", () => {
    const released = release(noChoices, "q1");
    expect(holds(released, "q1", false)).toBe(false);
    expect(holds(released, "q2", false)).toBe(true);
    expect(holds(take(released, "q1"), "q1", false)).toBe(true);
  });

  test("taken, it holds the box even over the person's own prompt", () => {
    expect(holds(take(noChoices, "q1"), "q1", true)).toBe(true);
    expect(holds(take(noChoices, "q1"), "q2", true)).toBe(false);
  });

  test("taken then let go again, it is let go", () => {
    expect(holds(release(take(noChoices, "q1"), "q1"), "q1", true)).toBe(false);
  });

  test("changes return new sets, leaving the old choices as they were", () => {
    const released = release(noChoices, "q1");
    take(released, "q1");
    expect(released.released.has("q1")).toBe(true);
    expect(noChoices.released.size).toBe(0);
  });
});
