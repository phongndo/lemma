import { describe, expect, it } from "vitest";
import { emptyUsage, lastHarness, NATIVE_HARNESS, transcript, turnHarnesses, viewHasOtherHarness } from "../src/index.ts";
import type { EventData, Message, SessionEvent } from "../src/index.ts";

let seq = 0;
const event = (data: EventData): SessionEvent => ({ seq: ++seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: seq, data });

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (content: Extract<Message, { role: "assistant" }>["content"]): Message => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "m",
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: 1,
});

describe("harnesses on a branch", () => {
  const branch = [
    event({ type: "turn-start", turnId: "t1" }),
    event({ type: "message", turnId: "t1", message: user("one") }),
    event({ type: "turn-start", turnId: "t2", harness: "opencode" }),
    event({ type: "message", turnId: "t2", message: user("two") }),
  ];

  it("names each turn's harness, the native one when a turn-start names none", () => {
    expect([...turnHarnesses(branch)]).toEqual([
      ["t1", NATIVE_HARNESS],
      ["t2", "opencode"],
    ]);
    expect(lastHarness(branch)).toBe("opencode");
    expect(lastHarness(branch.slice(0, 2))).toBe(NATIVE_HARNESS);
    expect(lastHarness([])).toBeUndefined();
  });

  it("finds another harness's messages in the model's view, but not behind a compaction", () => {
    expect(viewHasOtherHarness(branch, NATIVE_HARNESS)).toBe(true);
    expect(viewHasOtherHarness(branch.slice(0, 2), NATIVE_HARNESS)).toBe(false);
    expect(viewHasOtherHarness(branch, "opencode")).toBe(true);
    const handedOver = [...branch, event({ type: "turn-start", turnId: "t3" })];
    const kept = event({ type: "message", turnId: "t3", message: user("three") });
    const compacted = [...handedOver, kept, event({ type: "compaction", summary: "…", firstKeptId: kept.id, tokensBefore: 10, source: "agent" })];
    expect(viewHasOtherHarness(compacted, NATIVE_HARNESS)).toBe(false);
  });
});

describe("transcript", () => {
  it("renders messages as tagged blocks, without thinking, with tool input and output cut", () => {
    const text = transcript([
      user("Fix it"),
      assistant([
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
      ]),
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x".repeat(3000) }], isError: true, timestamp: 1 },
    ]);
    expect(text).toContain("<user>\nFix it\n</user>");
    expect(text).toContain('<assistant>\nLooking.\n[called read {"path":"a.ts"}]\n</assistant>');
    expect(text).toContain('<tool_result name="read" error="true">');
    expect(text).toContain("… [1000 more characters]");
    expect(text).not.toContain("secret");
  });

  it("keeps the newest blocks when it is too long, saying how many were left out", () => {
    const text = transcript([user("a".repeat(50)), user("b".repeat(50)), user("c".repeat(50))], 140);
    expect(text.startsWith("[1 earlier message left out]")).toBe(true);
    expect(text).toContain("b".repeat(50));
    expect(text).toContain("c".repeat(50));
    expect(text).not.toContain("a".repeat(50));
  });
});
