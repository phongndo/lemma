import { describe, expect, it } from "vitest";
import { answerText, entryKey, foldRunning, foldTurn } from "../src/model/fold.ts";
import type { TurnEntry } from "../src/model/fold.ts";
import type { EventData } from "@lemma/contracts";
import { assistant, branch, toolResult, transcriptOf, user } from "./fixtures.ts";

const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: "ls" } });
const turnOf = (...data: EventData[]) => transcriptOf(branch({ type: "turn-start", turnId: "t1" }, user("hi", "t1"), ...data)).turns[0]!;
const describeEntries = (entries: readonly TurnEntry[] | undefined) =>
  entries?.map((entry) =>
    entry.kind === "work"
      ? {
          work: entry.items.map((item) => (item.kind === "assistant" ? item.blocks.map((block) => block.kind) : item.kind)),
          tools: entry.tools,
          failed: entry.failed,
        }
      : entry.item.kind === "assistant"
        ? { answer: entry.item.blocks.map((block) => block.kind) }
        : entry.item.kind,
  );

describe("foldTurn", () => {
  it("folds the work before a finished turn's answer", () => {
    const turn = turnOf(
      {
        type: "message",
        turnId: "t1",
        stepId: "s1",
        message: assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Checking" }, call("c1")]),
      },
      toolResult("c1", "boom", { isError: true }),
      { type: "message", turnId: "t1", stepId: "s2", message: assistant([call("c2")]) },
      toolResult("c2", "ok"),
      {
        type: "message",
        turnId: "t1",
        stepId: "s3",
        message: assistant([
          { type: "thinking", thinking: "so" },
          { type: "text", text: "Done." },
        ]),
      },
      { type: "turn-end", turnId: "t1", reason: "done" },
    );
    const entries = foldTurn(turn);
    expect(describeEntries(entries)).toEqual([
      "user",
      { work: [["thinking", "text", "tool"], ["tool"], ["thinking"]], tools: 2, failed: 1 },
      { answer: ["text"] },
    ]);
    expect(entries![1]).toMatchObject({ key: "t1:work", duration: turn.endedAt! - turn.startedAt });
  });

  it("keeps a turn still running, or with nothing before its answer, as it is", () => {
    const running = turnOf({ type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1")]) });
    expect(foldTurn(running)).toBeUndefined();
    const chat = turnOf(
      {
        type: "message",
        turnId: "t1",
        stepId: "s1",
        message: assistant([
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Hi" },
        ]),
      },
      { type: "turn-end", turnId: "t1", reason: "done" },
    );
    expect(describeEntries(foldTurn(chat))).toEqual(["user", { work: [["thinking"]], tools: 0, failed: 0 }, { answer: ["text"] }]);
    const plain = turnOf(
      { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "Hi" }]) },
      { type: "turn-end", turnId: "t1", reason: "done" },
    );
    expect(foldTurn(plain)).toBeUndefined();
  });

  it("leaves an empty answer for a turn that stopped in a tool call, so its stop note shows", () => {
    const entries = foldTurn(
      turnOf(
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "Running" }, call("c1")], { stopReason: "aborted" }) },
        { type: "turn-end", turnId: "t1", reason: "cancelled" },
      ),
    );
    expect(describeEntries(entries)).toEqual(["user", { work: [["text", "tool"]], tools: 1, failed: 0 }, { answer: [] }]);
  });
});

describe("foldRunning", () => {
  const step = (n: number) => [
    { type: "message", turnId: "t1", stepId: `s${n}`, message: assistant([call(`c${n}`)]) } as EventData,
    toolResult(`c${n}`, "ok", { isError: n === 1 }),
  ];
  it("folds all of a running turn's work so far under the finished turn's key", () => {
    const entries = foldRunning(turnOf(...step(1), ...step(2), ...step(3)))!;
    expect(entries.map((entry) => entry.kind)).toEqual(["item", "work"]);
    expect(entries[1]).toMatchObject({ key: "t1:work", tools: 3, failed: 1, live: true });
    const ended = foldTurn(turnOf(...step(1), ...step(2), ...step(3), { type: "turn-end", turnId: "t1", reason: "done" }))!;
    expect(ended.map(entryKey).slice(0, 2)).toEqual(entries.map(entryKey));
  });

  it("keeps a steer where it joined, after the work it followed and before what answers it", () => {
    const turn = turnOf(...step(1), user("look at the tests too", "t1"), ...step(2));
    const entries = foldRunning(turn)!;
    expect(describeEntries(entries)).toEqual(["user", { work: [["tool"], "user", ["tool"]], tools: 2, failed: 1 }]);
  });

  it("has a fold from the start, for its streaming step to join", () => {
    expect(describeEntries(foldRunning(turnOf()))).toEqual(["user", { work: [], tools: 0, failed: 0 }]);
  });

  it("leaves finished turns alone", () => {
    expect(foldRunning(turnOf(...step(1), { type: "turn-end", turnId: "t1", reason: "done" }))).toBeUndefined();
  });
});

describe("answerText", () => {
  it("is the text the last assistant message ends with, after its last tool call", () => {
    const turn = turnOf(
      { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "Checking" }, call("c1")]) },
      toolResult("c1", "ok"),
      {
        type: "message",
        turnId: "t1",
        stepId: "s2",
        message: assistant([
          { type: "thinking", thinking: "so" },
          { type: "text", text: "## Done\n\n" },
          { type: "text", text: "All good." },
        ]),
      },
      { type: "turn-end", turnId: "t1", reason: "done" },
    );
    expect(answerText(turn)).toBe("## Done\n\nAll good.");
  });

  it("is empty when the turn stopped in a tool call", () => {
    expect(answerText(turnOf({ type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1")]) }))).toBe("");
  });
});
