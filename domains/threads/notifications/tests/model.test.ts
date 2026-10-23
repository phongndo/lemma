import { describe, expect, it } from "vitest";
import type { ThreadAttention } from "@lemma/threads";
import { DEFAULT_PREFS, arrivals, badgeCount, countedTitle, readPrefs, tellsBy, withChannel } from "../src/model.ts";

const at = (state: ThreadAttention["state"], label: string, since: number): ThreadAttention => ({ state, label, since });

describe("readPrefs", () => {
  it("keeps what reads and defaults the rest", () => {
    expect(readPrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(readPrefs({ channels: { done: ["sound", "bogus", "notice"] }, corner: "top-left" })).toEqual({
      channels: { waiting: DEFAULT_PREFS.channels.waiting, failed: DEFAULT_PREFS.channels.failed, done: ["notice", "sound"] },
      corner: "top-left",
    });
    expect(readPrefs({ channels: "all", corner: "middle" })).toEqual(DEFAULT_PREFS);
  });
});

describe("withChannel", () => {
  it("turns one channel of one state on or off, keeping the channels' order", () => {
    const quiet = withChannel(DEFAULT_PREFS, "waiting", "sound", false);
    expect(tellsBy(quiet, "waiting", "sound")).toBe(false);
    expect(tellsBy(quiet, "failed", "sound")).toBe(true);
    expect(withChannel(quiet, "done", "sound", true).channels.done).toEqual(["notice", "system", "badge", "sound"]);
    expect(withChannel(DEFAULT_PREFS, "done", "notice", true)).toEqual(DEFAULT_PREFS);
  });
});

describe("arrivals", () => {
  const never = () => false;

  it("tells a thread that begins waiting, fails, or finishes, but not one at work", () => {
    const before = new Map([["a", at("working", "Working", 1)]]);
    const after = new Map([
      ["a", at("done", "Done", 5)],
      ["b", at("waiting", "Needs approval", 6)],
      ["c", at("working", "Working", 7)],
    ]);
    expect(arrivals(before, after, never).map((arrival) => [arrival.sessionId, arrival.state])).toEqual([
      ["a", "done"],
      ["b", "waiting"],
    ]);
  });

  it("tells nothing again for what has not changed, but a new question in a thread already waiting", () => {
    const before = new Map([["a", at("waiting", "Needs approval", 1)]]);
    expect(arrivals(before, new Map(before), never)).toEqual([]);
    expect(arrivals(before, new Map([["a", at("waiting", "Needs input", 1)]]), never)).toHaveLength(1);
    expect(arrivals(new Map([["a", at("done", "Done", 1)]]), new Map([["a", at("done", "Done", 2)]]), never)).toHaveLength(1);
  });

  it("keeps quiet what the caller says to", () => {
    const after = new Map([
      ["shown", at("done", "Done", 5)],
      ["agent", at("failed", "Failed", 5)],
      ["other", at("failed", "Failed", 5)],
    ]);
    expect(arrivals(new Map(), after, (id) => id !== "other").map((arrival) => arrival.sessionId)).toEqual(["other"]);
  });
});

describe("badgeCount", () => {
  it("counts what needs the person by the states whose badge is on, an agent only while it waits", () => {
    const attention = new Map([
      ["a", at("waiting", "Needs approval", 1)],
      ["b", at("done", "Done", 1)],
      ["c", at("working", "Working", 1)],
      ["agent-done", at("done", "Done", 1)],
      ["agent-waiting", at("waiting", "Needs input", 1)],
    ]);
    const isAgent = (id: string) => id.startsWith("agent");
    expect(badgeCount(attention, DEFAULT_PREFS, isAgent)).toBe(3);
    expect(badgeCount(attention, withChannel(DEFAULT_PREFS, "done", "badge", false), isAgent)).toBe(2);
  });
});

describe("countedTitle", () => {
  it("puts the count in front of the title, as a browser tab shows it", () => {
    expect(countedTitle("lemma", 2)).toBe("(2) lemma");
    expect(countedTitle("lemma", 0)).toBe("lemma");
  });
});
