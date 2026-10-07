import { describe, expect, it } from "vitest";
import { plainText, thoughtHeadline, thoughtTitles } from "../src/model/thought.ts";

describe("thoughtHeadline", () => {
  const summary = "**Exploring cat play strategies**\n\nI'm thinking about wand toys.\n\n**Grouping the list**\n\nBalls, boxes, tunnels.";

  it("is the thought's first title, or its latest while it is written", () => {
    expect(thoughtTitles(summary)).toEqual(["Exploring cat play strategies", "Grouping the list"]);
    expect(thoughtHeadline(summary)).toBe("Exploring cat play strategies");
    expect(thoughtHeadline(summary, true)).toBe("Grouping the list");
  });

  it("falls back to the first line, or the latest while live, as plain text", () => {
    const text = "Let me check `fold.ts` first.\nThen the *tests*.";
    expect(thoughtHeadline(text)).toBe("Let me check fold.ts first.");
    expect(thoughtHeadline(text, true)).toBe("Then the tests.");
    expect(thoughtHeadline("## Plan\n\nsteps")).toBe("Plan");
    expect(thoughtHeadline("")).toBe("");
    expect(thoughtHeadline("**Read", true)).toBe("Read");
  });

  it("reads any line quickly, however it is made", () => {
    const started = performance.now();
    thoughtTitles(`# title${" ".repeat(5000)}x`);
    thoughtTitles(`**${"*".repeat(5000)}`);
    thoughtHeadline("_a".repeat(20000), true);
    thoughtHeadline("*".repeat(20000));
    expect(performance.now() - started).toBeLessThan(200);
    expect(thoughtTitles("## Plan ##\n**Steps:**\n**a** and **b**")).toEqual(["Plan", "Steps"]);
  });

  it("keeps a bold phrase inside a sentence as the sentence", () => {
    expect(thoughtTitles("This is **important** to check.")).toEqual([]);
    expect(plainText("- see [the docs](https://x.y) and snake_case_name")).toBe("see the docs and snake_case_name");
  });
});
