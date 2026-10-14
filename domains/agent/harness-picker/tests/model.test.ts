import { describe, expect, it } from "vitest";
import { effectiveAccess, effectiveHarness } from "../src/model.ts";

describe("the harness a turn runs on", () => {
  it("is the one picked for the thread, else its last turn's, else the default, else Lemma's own", () => {
    expect(effectiveHarness("codex", "claude", "gemini")).toBe("codex");
    expect(effectiveHarness(undefined, "claude", "gemini")).toBe("claude");
    expect(effectiveHarness(undefined, undefined, "gemini")).toBe("gemini");
    expect(effectiveHarness(undefined, undefined, undefined)).toBe("lemma");
  });
});

describe("the access a turn asks for", () => {
  it("is the thread's pick, else the harness's last, else supervised, of those the harness offers", () => {
    const all = ["supervised", "auto-edits", "auto", "full"] as const;
    expect(effectiveAccess("full", "auto", all)).toBe("full");
    expect(effectiveAccess(undefined, "auto", all)).toBe("auto");
    expect(effectiveAccess("auto", undefined, ["supervised", "auto-edits", "full"])).toBe("supervised");
    expect(effectiveAccess(undefined, undefined, ["full"])).toBe("full");
    expect(effectiveAccess("full", "full", [])).toBeUndefined();
  });
});
