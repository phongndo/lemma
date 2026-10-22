import { describe, expect, it } from "vitest";
import { emptyUsage } from "@lemma/llm";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { againAsk, cleanTitle, firstAsk, threadModel } from "../src/title.ts";

const log = (...data: EventData[]): SessionEvent[] =>
  data.map((entry, i) => ({ seq: i + 1, id: `e${i}`, parent: i === 0 ? null : `e${i - 1}`, at: i, data: entry }));
const said = (role: "user" | "assistant", text: string): EventData =>
  role === "user"
    ? { type: "message", message: { role, content: [{ type: "text", text }], timestamp: 1 } }
    : {
        type: "message",
        message: { role, content: [{ type: "text", text }], api: "x", provider: "p", model: "m", usage: emptyUsage, stopReason: "stop", timestamp: 1 },
      };
const turn = (model: string): EventData => ({ type: "turn-start", turnId: `t-${model}`, model }) as EventData;

const asked = "the upload test fails every other run on CI, can you find out why and fix it please";

describe("a title", () => {
  it("is asked of a small model for the thread's latest model", () => {
    expect(threadModel(log(turn("a/b"), said("user", "x"), turn("c/d")))).toBe("c/d");
    expect(threadModel(log(said("user", "x")))).toBeUndefined();
  });
});

describe("what the model is asked", () => {
  it("is the first prompt, its start and end kept when it is long", () => {
    expect(firstAsk([{ type: "text", text: asked }])).toContain(`<message>\n${asked}\n</message>`);
    const long = firstAsk([{ type: "text", text: `${"a".repeat(10_000)}FIX THE BUILD` }])!;
    expect(long.length).toBeLessThan(6_200);
    expect(long).toContain("[…]");
    expect(long).toContain("FIX THE BUILD");
    // An image alone has nothing to name.
    expect(firstAsk([{ type: "image", data: "", mimeType: "image/png" }])).toBeUndefined();
  });

  it("anew, is the first prompt and the latest messages, with the title now", () => {
    const many = Array.from({ length: 20 }, (_, i) => said(i % 2 === 0 ? "user" : "assistant", `message ${i} ${"x".repeat(800)}`));
    const ask = againAsk(log(said("user", "first request"), ...many), "Old title")!;
    expect(ask.indexOf("Person: first request")).toBeLessThan(ask.indexOf("message 19"));
    expect(ask).toContain("more messages]");
    expect(ask).not.toContain("message 0 ");
    expect(ask).toContain('Its title now is "Old title"');
    expect(againAsk(log(turn("a/b")), undefined)).toBeUndefined();
  });
});

describe("the title in an answer", () => {
  it("is its first line, bare", () => {
    expect(cleanTitle("Fix flaky upload test\nBecause the test…")).toBe("Fix flaky upload test");
    expect(cleanTitle('  "Fix flaky upload test."  ')).toBe("Fix flaky upload test");
    expect(cleanTitle("**Title:** Rust lifetime elision")).toBe("Rust lifetime elision");
    expect(cleanTitle("# Add dark mode")).toBe("Add dark mode");
    expect(cleanTitle('{"title": "Bump effect to 4.0.5"}')).toBe("Bump effect to 4.0.5");
    // A question keeps its mark.
    expect(cleanTitle("Why is the build slow?")).toBe("Why is the build slow?");
    expect(cleanTitle("- Fix flaky upload test")).toBe("Fix flaky upload test");
  });

  it("is found past what a model wraps it in", () => {
    expect(cleanTitle('{\n  "title": "Fix flaky test"\n}')).toBe("Fix flaky test");
    expect(cleanTitle("```\nFix flaky test\n```")).toBe("Fix flaky test");
    expect(cleanTitle("Title:\nFix flaky test")).toBe("Fix flaky test");
    expect(cleanTitle("**Title:**\n\nFix flaky test")).toBe("Fix flaky test");
    expect(cleanTitle("<think>\nThe person wants the test fixed.\n</think>\n\nFix flaky test")).toBe("Fix flaky test");
    // Reasoning cut off before any title: none.
    expect(cleanTitle("<think>\nThe person wants")).toBeUndefined();
  });

  it("keeps names as written: only what wraps the whole title goes", () => {
    expect(cleanTitle("`npm test` fails on CI")).toBe("npm test fails on CI");
    expect(cleanTitle("Explain Python __init__")).toBe("Explain Python __init__");
    expect(cleanTitle("Rename users'")).toBe("Rename users'");
    expect(cleanTitle("**Fix the “flaky” test**")).toBe("Fix the “flaky” test");
    expect(cleanTitle("_Rust lifetime elision_")).toBe("Rust lifetime elision");
  });

  it("is cut at a word when long, and none when empty", () => {
    const long = cleanTitle("Investigate why the nightly release pipeline intermittently fails while signing the macOS app")!;
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanTitle("\n  \n")).toBeUndefined();
    expect(cleanTitle('""')).toBeUndefined();
  });
});
