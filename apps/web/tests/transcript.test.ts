import { describe, expect, it } from "vitest";
import { createProjector, pendingToolCalls, promptMarks } from "../src/model/transcript.ts";
import type { AssistantItem } from "../src/model/transcript.ts";
import { assistant, branch, toolResult, transcriptOf, usage, user } from "./fixtures.ts";

const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: "ls" } });

describe("transcript", () => {
  it("groups a turn and pairs tool calls with results", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("hi", "t1"),
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }, call("c1")]) },
        toolResult("c1", "a\nb", { details: { exitCode: 0 } }),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "done" }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    expect(t.turns).toHaveLength(1);
    const turn = t.turns[0]!;
    expect(turn.turnId).toBe("t1");
    expect(turn.items.map((item) => item.kind)).toEqual(["user", "assistant", "assistant"]);
    const first = turn.items[1] as AssistantItem;
    expect(first.blocks.map((block) => block.kind)).toEqual(["thinking", "text", "tool"]);
    const tool = first.blocks[2]!;
    expect(tool.kind === "tool" && tool.result?.details).toEqual({ exitCode: 0 });
    expect(turn.steps).toBe(2);
    expect(turn.usage.input).toBe(20);
    expect(turn.end).toEqual({ reason: "done" });
    expect(turn.endedAt! - turn.startedAt).toBe(5000);
  });

  it("attaches turn-start to a preceding user message", () => {
    const t = transcriptOf(branch(user("hi"), { type: "turn-start", turnId: "t1" }, { type: "turn-end", turnId: "t1", reason: "cancelled" }));
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ key: "t1", turnId: "t1", end: { reason: "cancelled" } });
  });

  it("starts a new turn per user message and per turn-start", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("a", "t1"),
        { type: "message", turnId: "t1", message: assistant([{ type: "text", text: "x" }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
        { type: "turn-start", turnId: "t2" },
        user("b", "t2"),
      ),
    );
    expect(t.turns.map((turn) => turn.key)).toEqual(["t1", "t2"]);
    expect(t.turns[1]!.end).toBeUndefined();
  });

  it("shows a steer in the turn it joined, between its steps", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("a", "t1"),
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "working" }]) },
        user("also b", "t1"),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "both done" }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("shows attempts distinctly and counts their usage but not as steps", () => {
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        {
          type: "attempt",
          turnId: "t1",
          stepId: "s1",
          message: assistant([], { stopReason: "error", errorMessage: "overloaded", usage: usage(3, 0) }),
          timing: { startedAt: 0, endedAt: 5 },
        },
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "ok" }]) },
      ),
    );
    const turn = t.turns[0]!;
    expect(turn.items.map((item) => item.kind)).toEqual(["attempt", "assistant"]);
    expect(turn.steps).toBe(1);
    expect(turn.usage.input).toBe(13);
  });

  it("keeps the latest title, compactions, and orphan results", () => {
    const t = transcriptOf(
      branch(
        { type: "title", title: "one" },
        { type: "compaction", summary: "s", firstKeptId: "e1", tokensBefore: 900, source: "x" },
        toolResult("nope", "?"),
        { type: "title", title: "two" },
      ),
    );
    expect(t.title).toBe("two");
    expect(t.turns[0]!.items.map((item) => item.kind)).toEqual(["compaction", "orphan-result"]);
  });

  it("lists pending tool calls", () => {
    const t = transcriptOf(
      branch({ type: "turn-start", turnId: "t1" }, { type: "message", turnId: "t1", message: assistant([call("c1"), call("c2")]) }, toolResult("c1", "x")),
    );
    expect([...pendingToolCalls(t)]).toEqual(["c2"]);
  });
});

describe("createProjector", () => {
  it("reuses unchanged items, blocks, and turns across calls", () => {
    const project = createProjector();
    const events = branch(
      { type: "turn-start", turnId: "t1" },
      user("hi", "t1"),
      { type: "message", turnId: "t1", message: assistant([{ type: "text", text: "a" }, call("c1")]) },
      { type: "turn-end", turnId: "t1", reason: "done" },
      { type: "turn-start", turnId: "t2" },
      user("next", "t2"),
      { type: "message", turnId: "t2", message: assistant([call("c2")]) },
    );
    const before = project(events);
    const after = project([...events, { seq: 8, id: "e8", parent: "e7", at: 9000, data: toolResult("c2", "out") }]);
    expect(after.turns[0]).toBe(before.turns[0]);
    const [a, b] = [before.turns[1]!, after.turns[1]!];
    expect(b).not.toBe(a);
    expect(b.items[0]).toBe(a.items[0]);
    expect(b.items[1]).not.toBe(a.items[1]);
    const block = (b.items[1] as AssistantItem).blocks[0]!;
    expect(block.kind === "tool" && block.result?.content).toEqual([{ type: "text", text: "out" }]);
    // Stable again once nothing changes.
    const again = project([...events, { seq: 8, id: "e8", parent: "e7", at: 9000, data: toolResult("c2", "out") }]);
    expect(again.turns[1]).toBe(b);
  });
});

describe("promptMarks", () => {
  it("marks each turn that starts with a prompt, with its answer", () => {
    const answer = "## Fixed\n\nThe **cause** was `retry_count`.";
    const t = transcriptOf(
      branch(
        { type: "turn-start", turnId: "t1" },
        user("fix   the\nbuild", "t1"),
        {
          type: "message",
          turnId: "t1",
          stepId: "s1",
          message: assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Reading the log." }, call("c1")]),
        },
        toolResult("c1", "ok"),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: answer }]) },
        { type: "turn-end", turnId: "t1", reason: "done" },
        { type: "turn-start", turnId: "t2" },
        { type: "message", turnId: "t2", message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 0 } },
        // Cut off after a note and a tool call: the note is not its answer.
        { type: "message", turnId: "t2", stepId: "s3", message: assistant([{ type: "text", text: "Let me look." }, call("c2")]) },
        { type: "turn-end", turnId: "t2", reason: "cancelled" },
      ),
    );
    expect(promptMarks(t.turns)).toEqual([
      { key: "t1", prompt: "fix the build", reply: answer },
      { key: "t2", prompt: "Image", reply: "" },
    ]);
  });
});
