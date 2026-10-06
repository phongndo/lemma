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

  it("keeps a turn still running, or without tool calls, as it is", () => {
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
    expect(foldTurn(chat)).toBeUndefined();
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
  it("folds a running turn's earlier steps under the finished turn's key, keeping the last two", () => {
    const turn = turnOf(...step(1), ...step(2), ...step(3), ...step(4));
    const entries = foldRunning(turn)!;
    expect(entries.map((entry) => entry.kind)).toEqual(["item", "work", "item", "item"]);
    expect(entries[1]).toMatchObject({ key: "t1:work", tools: 2, failed: 1, live: true });
  });

  it("keys entries so what stays in view keeps its key as the turn runs on and ends", () => {
    const running = foldRunning(turnOf(...step(1), ...step(2), ...step(3)))!;
    const later = foldRunning(turnOf(...step(1), ...step(2), ...step(3), ...step(4)))!;
    const ended = foldTurn(turnOf(...step(1), ...step(2), ...step(3), ...step(4), { type: "turn-end", turnId: "t1", reason: "done" }))!;
    const keys = (entries: readonly TurnEntry[]) => entries.map(entryKey);
    expect(new Set(keys(running)).size).toBe(running.length);
    // The fold and the prompt keep theirs; the last step stays in view under its own.
    expect(keys(later).slice(0, 2)).toEqual(keys(running).slice(0, 2));
    expect(keys(later)).toContain(keys(running).at(-1));
    expect(keys(ended).slice(0, 2)).toEqual(keys(later).slice(0, 2));
  });

  it("leaves short and finished turns alone", () => {
    expect(foldRunning(turnOf(...step(1), ...step(2)))).toBeUndefined();
    expect(foldRunning(turnOf(...step(1), ...step(2), ...step(3), { type: "turn-end", turnId: "t1", reason: "done" }))).toBeUndefined();
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
