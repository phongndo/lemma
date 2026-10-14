import { describe, expect, test } from "vitest";
import type { ThreadsService } from "@lemma/threads";
import { recallStep, recallTarget, sentPrompts } from "../src/history.ts";

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

describe("recallTarget", () => {
  const sent = [
    { text: "first", images: [] },
    { text: "second", images: [image] },
  ];
  const empty = { text: "", images: [], recalledAt: undefined, selectionStart: 0, selectionEnd: 0 };

  test("Up in an empty composer brings back the newest; Down past the newest empties it", () => {
    expect(recallTarget(() => sent, empty, "older")).toEqual({ at: 1, prompt: sent[1] });
    const holding = { text: "second", images: [image], recalledAt: 1, selectionStart: 6, selectionEnd: 6 };
    expect(recallTarget(() => sent, holding, "older")).toEqual({ at: 0, prompt: sent[0] });
    expect(recallTarget(() => sent, holding, "newer")).toEqual({ at: undefined, prompt: { text: "", images: [] } });
  });

  test("a composer holding a prompt of its own leaves the key to the field, without reading the branch", () => {
    const read = () => {
      throw new Error("read the branch");
    };
    expect(recallTarget(read, { ...empty, text: "mine" }, "older")).toBeUndefined();
    expect(recallTarget(read, { ...empty, images: [image] }, "older")).toBeUndefined();
  });

  test("one brought back goes on only with the cursor collapsed at its start or end", () => {
    const at = (selectionStart: number, selectionEnd = selectionStart) => ({ text: "first", images: [], recalledAt: 0, selectionStart, selectionEnd });
    expect(recallTarget(() => sent, at(0), "newer")?.at).toBe(1);
    expect(recallTarget(() => sent, at(5), "newer")?.at).toBe(1);
    expect(recallTarget(() => sent, at(2), "newer")).toBeUndefined();
    expect(recallTarget(() => sent, at(0, 5), "newer")).toBeUndefined();
  });

  test("with nowhere further to go, the key is the field's", () => {
    expect(recallTarget(() => sent, { text: "first", images: [], recalledAt: 0, selectionStart: 0, selectionEnd: 0 }, "older")).toBeUndefined();
    expect(recallTarget(() => sent, empty, "newer")).toBeUndefined();
    expect(recallTarget(() => [], empty, "older")).toBeUndefined();
  });
});
