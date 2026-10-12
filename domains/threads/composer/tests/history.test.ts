import { describe, expect, test } from "vitest";
import type { ThreadsService } from "@lemma/threads";
import { recallStep, sentPrompts } from "../src/history.ts";

type BranchEvent = ReturnType<ThreadsService["branch"]>[number];

let seq = 0;
const event = (data: unknown): BranchEvent => ({ seq: ++seq, id: `e${seq}`, parent: null, at: seq, data }) as BranchEvent;
const user = (...content: unknown[]) => event({ type: "message", message: { role: "user", content, timestamp: 0 } });
const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

describe("sentPrompts", () => {
  test("is the branch's user messages, oldest first, with their text joined and their images", () => {
    const branch = [
      event({ type: "turn-start", turnId: "t1" }),
      user({ type: "text", text: "fix the test" }),
      event({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
      user({ type: "text", text: "now" }, { type: "text", text: "the docs" }, image),
      user(image),
    ];
    expect(sentPrompts(branch)).toEqual([
      { text: "fix the test", images: [] },
      { text: "now\n\nthe docs", images: [image] },
      { text: "", images: [image] },
    ]);
  });
});

describe("recallStep", () => {
  test("Up goes from none to the newest, then older, and stops at the oldest", () => {
    expect(recallStep(3, undefined, "older")).toBe(2);
    expect(recallStep(3, 2, "older")).toBe(1);
    expect(recallStep(3, 0, "older")).toBe(0);
  });

  test("Down goes newer, and past the newest back to none", () => {
    expect(recallStep(3, 0, "newer")).toBe(1);
    expect(recallStep(3, 2, "newer")).toBeUndefined();
    expect(recallStep(3, undefined, "newer")).toBeUndefined();
  });

  test("with nothing sent, there is nothing to bring back", () => {
    expect(recallStep(0, undefined, "older")).toBeUndefined();
  });

  test("from a place the branch no longer reaches (checked out further back), as from none", () => {
    expect(recallStep(2, 4, "older")).toBe(1);
    expect(recallStep(2, 4, "newer")).toBeUndefined();
    expect(recallStep(0, 4, "older")).toBeUndefined();
  });
});
