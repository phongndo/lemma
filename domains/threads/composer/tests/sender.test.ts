import { describe, expect, test } from "vitest";
import type { PromptContent } from "@lemma/agent";
import { keepDraft } from "../src/drafts.ts";
import type { Draft, Drafts, Prompt } from "../src/drafts.ts";
import { createSender, promptContent } from "../src/sender.ts";
import type { Outgoing, WhenBusy } from "../src/sender.ts";

const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

interface Placed {
  readonly prompt: Outgoing;
  readonly content: PromptContent;
  readonly whenBusy: WhenBusy;
  readonly key: string;
  /** Answers the placing: taken (`true`), refused (`false`), or failed (an Error). */
  readonly answer: (result: boolean | Error) => void;
}

/**
 * A composer and host as plain state: what the composer holds is kept as the shown thread's draft, as the component's
 * effect keeps it, and each placing waits for the test to answer it.
 */
const harness = (key = "t1") => {
  const state = { key, composer: { text: "", images: [] } as Prompt, sending: false, connected: true, ids: 0, settled: 0 };
  const drafts: Drafts = new Map();
  const outgoing = new Set<Draft>();
  const placed: Placed[] = [];
  const reported: unknown[] = [];
  const hold = (text: string, images: Prompt["images"]) => {
    state.composer = { text, images };
    keepDraft(drafts, state.key, state.composer, false);
  };
  const sender = createSender({
    drafts,
    outgoing,
    key: () => state.key,
    read: () => state.composer,
    write: (prompt) => hold(prompt.text, prompt.images),
    sending: () => state.sending,
    setSending: (sending) => void (state.sending = sending),
    connected: () => state.connected,
    newRequestId: () => `r${++state.ids}`,
    starting: () => {},
    place: (prompt, content, whenBusy) =>
      new Promise((resolve, reject) => {
        placed.push({ prompt, content, whenBusy, key: state.key, answer: (result) => (result instanceof Error ? reject(result) : resolve(result)) });
      }),
    report: (error) => void reported.push(error),
    settled: () => void state.settled++,
  });
  return { state, drafts, outgoing, placed, reported, sender, type: (text: string, images: Prompt["images"] = []) => hold(text, images) };
};

describe("promptContent", () => {
  test("is the text, unless only whitespace, then the images", () => {
    expect(promptContent({ text: "hi", images: [image] })).toEqual([{ type: "text", text: "hi" }, image]);
    expect(promptContent({ text: "  ", images: [image] })).toEqual([image]);
  });
});

describe("createSender", () => {
  test("sends what the composer holds, clearing it while it goes out, outgoing until taken", async () => {
    const h = harness();
    h.type("fix the test");
    const sending = h.sender.send("steer");
    expect(h.placed.map((p) => [p.prompt, p.content, p.whenBusy])).toEqual([
      [{ text: "fix the test", images: [], requestId: "r1" }, [{ type: "text", text: "fix the test" }], "steer"],
    ]);
    expect(h.state.composer).toEqual({ text: "", images: [] });
    expect(h.state.sending).toBe(true);
    expect(h.drafts.get("t1")).toEqual({ text: "", images: [] });
    expect([...h.outgoing]).toEqual([h.placed[0]!.prompt]);
    h.type("next one");
    h.placed[0]!.answer(true);
    await sending;
    expect(h.state.sending).toBe(false);
    expect(h.outgoing.size).toBe(0);
    expect(h.state.composer.text).toBe("next one");
    expect(h.state.settled).toBe(1);
  });

  test("sends nothing when disconnected or with nothing written", async () => {
    const h = harness();
    h.type("  ");
    expect(h.sender.canSend()).toBe(false);
    await h.sender.send("steer");
    h.type("hi");
    h.state.connected = false;
    expect(h.sender.canSend()).toBe(false);
    await h.sender.send("steer");
    expect(h.placed).toEqual([]);
  });

  test("refused, it comes back unchanged with its request id, so sending it again places it once", async () => {
    const h = harness();
    h.type("fix it", [image]);
    const first = h.sender.send("steer");
    h.placed[0]!.answer(false);
    await first;
    expect(h.state.composer).toEqual({ text: "fix it", images: [image] });
    expect(h.drafts.get("t1")).toEqual({ text: "fix it", images: [image], requestId: "r1" });
    const again = h.sender.send("follow-up");
    expect(h.placed[1]!.prompt.requestId).toBe("r1");
    h.placed[1]!.answer(true);
    await again;
  });

  test("refused, it goes ahead of what was typed since, as a new prompt", async () => {
    const h = harness();
    h.type("fix it");
    const sending = h.sender.send("steer");
    h.type("and the docs");
    h.placed[0]!.answer(false);
    await sending;
    expect(h.state.composer).toEqual({ text: "fix it\n\nand the docs", images: [] });
    expect(h.drafts.get("t1")).toEqual({ text: "fix it\n\nand the docs", images: [] });
  });

  test("a placing that throws is reported, and the prompt comes back", async () => {
    const h = harness();
    h.type("fix it");
    const sending = h.sender.send("steer");
    const error = new Error("no worktree");
    h.placed[0]!.answer(error);
    await sending;
    expect(h.reported).toEqual([error]);
    expect(h.drafts.get("t1")).toEqual({ text: "fix it", images: [], requestId: "r1" });
  });

  test("refused in another thread than the one shown, it returns to its own, leaving the composer alone", async () => {
    const h = harness();
    h.type("fix it");
    const sending = h.sender.send("steer");
    h.state.key = "t2";
    h.type("elsewhere");
    h.placed[0]!.answer(false);
    await sending;
    expect(h.drafts.get("t1")).toEqual({ text: "fix it", images: [], requestId: "r1" });
    expect(h.state.composer.text).toBe("elsewhere");
  });

  test("a new chat's prompt, refused, returns to the session placing it created and now shown", async () => {
    const h = harness("");
    h.type("start");
    const sending = h.sender.send("steer");
    h.state.key = "created";
    h.placed[0]!.answer(false);
    await sending;
    expect(h.drafts.get("created")).toEqual({ text: "start", images: [], requestId: "r1" });
    expect(h.drafts.get("")).toEqual({ text: "", images: [] });
    expect(h.state.composer.text).toBe("start");
  });

  test("a send asked for while one goes out follows it once taken, if the composer holds the same still", async () => {
    const h = harness();
    h.type("one");
    const first = h.sender.send("steer");
    h.type("two");
    await h.sender.send("follow-up");
    expect(h.placed).toHaveLength(1);
    h.placed[0]!.answer(true);
    await first;
    expect(h.placed.map((p) => [p.prompt.text, p.whenBusy])).toEqual([
      ["one", "steer"],
      ["two", "follow-up"],
    ]);
    expect(h.placed[1]!.prompt.requestId).toBe("r2");
  });

  test("the waiting send is dropped when the composer changed since, or the first was refused", async () => {
    const changed = harness();
    changed.type("one");
    const first = changed.sender.send("steer");
    changed.type("two");
    await changed.sender.send("steer");
    changed.type("two, edited");
    changed.placed[0]!.answer(true);
    await first;
    expect(changed.placed).toHaveLength(1);

    const refused = harness();
    refused.type("one");
    const sending = refused.sender.send("steer");
    refused.type("two");
    await refused.sender.send("steer");
    refused.placed[0]!.answer(false);
    await sending;
    expect(refused.placed).toHaveLength(1);
    expect(refused.state.composer.text).toBe("one\n\ntwo");
  });

  test("a send asked for while one goes out, with nothing written, waits for nothing", async () => {
    const h = harness();
    h.type("one");
    const first = h.sender.send("steer");
    await h.sender.send("steer");
    h.placed[0]!.answer(true);
    await first;
    expect(h.placed).toHaveLength(1);
  });
});
