import { describe, expect, it } from "vitest";
import { branchOf, deriveMessages, messageOf, modelEntries, rebuildRequest, requestState } from "../src/derive.ts";
import type { EventData, SessionEvent } from "../src/sessions.ts";
import { emptyUsage } from "@lemma/llm";

function log(...items: readonly (EventData | { readonly data: EventData; readonly parent: string })[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  items.forEach((item, i) => {
    const explicit = "parent" in item && "data" in item;
    events.push({
      seq: i + 1,
      id: `e${i + 1}`,
      parent: explicit ? item.parent : i === 0 ? null : `e${i}`,
      at: 1000 + i,
      data: explicit ? item.data : (item as EventData),
    });
  });
  return events;
}

const user = (text: string): EventData => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
const assistant = (text: string): EventData => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "p",
    model: "m",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 0,
  },
});
const request = (extra: Partial<Extract<EventData, { type: "request" }>> = {}): EventData => ({
  type: "request",
  turnId: "t",
  stepId: "s",
  model: "p/m",
  composition: "c",
  contributions: [],
  ...extra,
});

describe("branchOf", () => {
  it("follows parents from the leaf and ignores sibling branches", () => {
    const events = log(user("a"), assistant("b"), { data: user("c2"), parent: "e1" });
    expect(branchOf(events, "e3").map((event) => event.id)).toEqual(["e1", "e3"]);
    expect(branchOf(events, "e2").map((event) => event.id)).toEqual(["e1", "e2"]);
    expect(branchOf(events, undefined)).toEqual([]);
  });
});

describe("deriveMessages", () => {
  it("replaces history before firstKeptId with the latest summary", () => {
    const events = log(
      user("old"),
      assistant("old reply"),
      user("kept"),
      { type: "compaction", summary: "S", firstKeptId: "e3", tokensBefore: 10, source: "compaction" },
      assistant("new"),
    );
    const messages = deriveMessages(events);
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages[0])).toContain("S");
    expect(messages[1]!.role).toBe("user");
    expect(messages[2]!.role).toBe("assistant");
  });

  it("ignores attempts and non-message events", () => {
    const events = log({ type: "turn-start", turnId: "t" }, user("hi"), request(), {
      type: "attempt",
      turnId: "t",
      stepId: "s",
      message: { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage: emptyUsage, stopReason: "error", timestamp: 0 },
      timing: { startedAt: 0, endedAt: 1 },
    });
    expect(deriveMessages(events)).toHaveLength(1);
  });

  it("shows tool results in the order of the calls, however they were logged", () => {
    const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
    const result = (toolCallId: string): EventData => ({
      type: "message",
      message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: toolCallId }], isError: false, timestamp: 0 },
    });
    const calls: EventData = {
      type: "message",
      message: {
        role: "assistant",
        content: [call("c1"), call("c2"), call("c3")],
        api: "test",
        provider: "p",
        model: "m",
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 0,
      },
    };
    const events = log(user("go"), calls, result("c3"), result("c1"), result("c2"), assistant("done"));
    const messages = deriveMessages(events);
    expect(messages.map((message) => (message.role === "toolResult" ? message.toolCallId : message.role))).toEqual([
      "user",
      "assistant",
      "c1",
      "c2",
      "c3",
      "assistant",
    ]);
  });
});

describe("modelEntries", () => {
  it("is deriveMessages with where each message comes from: the summary from its compaction, the rest from their events", () => {
    const events = log(
      user("old"),
      assistant("old reply"),
      user("kept"),
      { type: "compaction", summary: "S", firstKeptId: "e3", tokensBefore: 10, source: "compaction" },
      { type: "title", title: "t" },
      assistant("new"),
    );
    const entries = modelEntries(events);
    expect(entries.map((entry) => entry.message)).toEqual(deriveMessages(events));
    expect(entries.map((entry) => [entry.index, entry.summary === true])).toEqual([
      [3, true],
      [2, false],
      [5, false],
    ]);
  });

  it("keeps each tool result's event when it puts results in call order", () => {
    const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
    const result = (toolCallId: string): EventData => ({
      type: "message",
      message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: toolCallId }], isError: false, timestamp: 0 },
    });
    const calls: EventData = {
      type: "message",
      message: {
        role: "assistant",
        content: [call("c1"), call("c2")],
        api: "test",
        provider: "p",
        model: "m",
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 0,
      },
    };
    const events = log(user("go"), calls, result("c2"), result("c1"));
    expect(modelEntries(events).map((entry) => entry.index)).toEqual([0, 1, 3, 2]);
  });

  it("takes a message only from a message event", () => {
    const events = log(user("hi"), { type: "custom", kind: "x.y", data: 1 }, { type: "turn-start", turnId: "t" });
    expect(events.map((event) => messageOf(event) !== undefined)).toEqual([true, false, false]);
  });
});

describe("request reconstruction", () => {
  it("resolves omitted system and tools from earlier requests", () => {
    const tool = { name: "read", description: "Read", parameters: {} };
    const events = log(user("one"), request({ system: "SYS", tools: [tool] }), assistant("r1"), user("two"), request({ thinking: "high" }));
    expect(requestState(events)).toEqual({ model: "p/m", thinking: "high", system: "SYS", tools: [tool] });

    const second = rebuildRequest(events, "e5", "sid")!;
    expect(second.system).toBe("SYS");
    expect(second.tools).toEqual([tool]);
    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second.sessionId).toBe("sid");

    const first = rebuildRequest(events, "e2")!;
    expect(first.messages).toHaveLength(1);
    expect(rebuildRequest(events, "e1")).toBeUndefined();
  });
});
