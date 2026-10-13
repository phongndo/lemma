import { describe, expect, it } from "vitest";
import type { EventData } from "@lemma/sessions";
import { assistant, branch, usage, user } from "@lemma/threads/testing";
import { measuredTokens } from "../src/compact.ts";
import { lastCacheHit } from "../src/meter.ts";

const answer = (input: number, output: number, cacheRead = 0): EventData => ({
  type: "message",
  message: assistant([], { usage: { ...usage(input, output), cacheRead } }),
});
const compaction: EventData = { type: "compaction", summary: "s", firstKeptId: "e1", tokensBefore: 110, source: "context.compaction" };

describe("the meter", () => {
  it("measures the last answer, cache included, and estimates what came after it", () => {
    expect(measuredTokens(branch(user("a"), answer(1000, 20, 3000)))).toBe(4020);
    expect(measuredTokens(branch(user("a"), answer(1000, 20, 3000), user("x".repeat(400))))).toBe(4120);
    expect(measuredTokens(branch(user("a"), answer(100, 10), answer(0, 0)))).toBe(110);
  });

  it("measures nothing before the first answer, or after a compaction until the next", () => {
    expect(measuredTokens(branch(user("a")))).toBeUndefined();
    expect(measuredTokens(branch(user("a"), answer(100, 10, 300), compaction))).toBeUndefined();
  });

  it("reads the last answer's cache hit, a compaction or not", () => {
    expect(lastCacheHit(branch(user("a")))).toBeUndefined();
    expect(lastCacheHit(branch(user("a"), answer(100, 10, 300), compaction))).toBe(0.75);
  });
});
