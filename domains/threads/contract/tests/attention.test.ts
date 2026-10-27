import { describe, expect, it } from "vitest";
import { attentionOf, isUnseenEnd, tells } from "../src/attention.ts";

describe("attentionOf", () => {
  it("puts what waits on the person above a running turn, and a running turn above a turn's end", () => {
    const end = { reason: "done", at: 50 } as const;
    expect(attentionOf({ waiting: "Needs approval", waitingSince: 30, running: true, runningSince: 10, unseen: end }, 99)).toEqual({
      state: "waiting",
      label: "Needs approval",
      since: 30,
    });
    expect(attentionOf({ running: true, runningSince: 10, unseen: end }, 99)).toEqual({ state: "working", label: "Working", since: 10 });
    expect(attentionOf({ running: false, unseen: end }, 99)).toEqual({ state: "done", label: "Done", since: 50 });
  });

  it("says how a turn stopped short, and nothing for a thread at rest", () => {
    expect(attentionOf({ running: false, unseen: { reason: "error", at: 5 } }, 9)).toEqual({ state: "failed", label: "Failed", since: 5 });
    expect(attentionOf({ running: false, unseen: { reason: "max-steps", at: 5 } }, 9)).toEqual({ state: "failed", label: "Out of steps", since: 5 });
    expect(attentionOf({ running: false }, 9)).toBeUndefined();
  });

  it("counts from now what this page did not see begin", () => {
    expect(attentionOf({ waiting: "Needs input", running: false }, 42)?.since).toBe(42);
    expect(attentionOf({ running: true }, 42)?.since).toBe(42);
  });
});

describe("tells", () => {
  it("tells of every end but one the person cancelled", () => {
    expect(["done", "error", "max-steps", "cancelled"].filter((reason) => tells(reason as never))).toEqual(["done", "error", "max-steps"]);
  });
});

describe("isUnseenEnd", () => {
  it("reads what storage holds only as far as it is an end", () => {
    expect(isUnseenEnd({ reason: "done", at: 1 })).toBe(true);
    expect(isUnseenEnd({ reason: "cancelled", at: 1 })).toBe(false);
    expect(isUnseenEnd({ reason: "done" })).toBe(false);
    expect(isUnseenEnd("done")).toBe(false);
    expect(isUnseenEnd(null)).toBe(false);
  });
});
