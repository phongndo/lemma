import { isDeepStrictEqual } from "node:util";
import { Equal, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  branchOf,
  customEvents,
  deriveHistory,
  deriveMessages,
  lastPromptText,
  latestDetails,
  messageOf,
  modelEntries,
  promptUpdateText,
  rebuildRequest,
  requestState,
  summaryText,
} from "../src/derive.ts";
import { SessionEvent } from "../src/sessions.ts";
import type { Contribution, EventData } from "../src/sessions.ts";
import { trajectory } from "../src/trajectory.ts";
import { contentText, emptyUsage, LlmRequest } from "@lemma/llm";
import type { Message } from "@lemma/llm";

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

  it("shows a context event to the model as a user message, after the tool results of a response it lands among", () => {
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
    const context = (text: string): EventData => ({ type: "context", source: "mail", content: [{ type: "text", text }], display: "1 new email" });
    const events = log(user("go"), calls, result("c1"), context("An email arrived"), result("c2"), context("Another"), assistant("done"));
    const roles = deriveMessages(events).map((message) =>
      message.role === "toolResult" ? message.toolCallId : message.role === "user" ? JSON.stringify(message.content[0]) : message.role,
    );
    expect(roles).toEqual([
      JSON.stringify({ type: "text", text: "go" }),
      "assistant",
      "c1",
      "c2",
      JSON.stringify({ type: "text", text: "An email arrived" }),
      JSON.stringify({ type: "text", text: "Another" }),
      "assistant",
    ]);
    expect(
      modelEntries(events)
        .filter((entry) => entry.context === true)
        .map((entry) => entry.index),
    ).toEqual([3, 5]);
  });

  describe("context-edit", () => {
    const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
    const result = (toolCallId: string, text = toolCallId): EventData => ({
      type: "message",
      message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 },
    });
    const calls: EventData = {
      type: "message",
      message: { role: "assistant", content: [call("c1")], api: "test", provider: "p", model: "m", usage: emptyUsage, stopReason: "toolUse", timestamp: 0 },
    };
    const edit = (target: string, op: "omit" | "replace", text?: string): EventData => ({
      type: "context-edit",
      target,
      op,
      ...(text === undefined ? {} : { content: [{ type: "text", text }] }),
      source: "test",
    });
    const shown = (events: readonly SessionEvent[]) =>
      deriveMessages(events).map((message) =>
        message.role === "assistant" ? "assistant" : `${message.role}:${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`,
      );

    it("replaces a tool result's content, keeping its place and role; the latest edit wins", () => {
      const events = log(user("go"), calls, result("c1", "a long output"), edit("e3", "replace", "short"), edit("e3", "replace", "shorter"));
      expect(shown(events)).toEqual(["user:go", "assistant", "toolResult:shorter"]);
      // The log keeps the original.
      expect(JSON.stringify(events[2]!.data)).toContain("a long output");
    });

    it("omits a prompt, and a response with its results, but never a lone result or a response's content", () => {
      expect(shown(log(user("one"), user("two"), edit("e1", "omit")))).toEqual(["user:two"]);
      expect(shown(log(user("go"), calls, result("c1"), assistant("done"), edit("e2", "omit")))).toEqual(["user:go", "assistant"]);
      expect(shown(log(user("go"), calls, result("c1"), edit("e3", "omit")))).toEqual(["user:go", "assistant", "toolResult:c1"]);
      expect(shown(log(user("go"), assistant("hi"), edit("e2", "replace", "rewritten")))).toEqual(["user:go", "assistant"]);
    });

    it("leaves an earlier edit in force when a later one cannot apply", () => {
      // An omit cannot apply to a lone result, so the shortening before it still holds.
      const events = log(user("go"), calls, result("c1", "a long output"), edit("e3", "replace", "short"), edit("e3", "omit"));
      expect(shown(events)).toEqual(["user:go", "assistant", "toolResult:short"]);
      // A replace cannot apply to a response, so the omit before it still holds.
      expect(shown(log(user("go"), assistant("hi"), edit("e2", "omit"), edit("e2", "replace", "rewritten")))).toEqual(["user:go"]);
    });

    it("changes nothing for a target a compaction summarized, or one not on the branch", () => {
      const events = log(
        user("old"),
        assistant("old reply"),
        user("kept"),
        { type: "compaction", summary: "S", firstKeptId: "e3", tokensBefore: 10, source: "compaction" },
        edit("e1", "replace", "never seen"),
        edit("nowhere", "omit"),
      );
      expect(shown(events).slice(1)).toEqual(["user:kept"]);
    });
  });

  it("takes a message only from a message event", () => {
    const events = log(user("hi"), { type: "custom", kind: "x.y", data: 1 }, { type: "turn-start", turnId: "t" });
    expect(events.map((event) => messageOf(event) !== undefined)).toEqual([true, false, false]);
    expect(messageOf(log({ type: "context", source: "x", content: [{ type: "text", text: "seen" }] })[0]!)).toEqual({
      role: "user",
      content: [{ type: "text", text: "seen" }],
      timestamp: 1000,
    });
  });
});

describe("reading a plugin's state back", () => {
  const result = (toolName: string, details: unknown, isError = false): EventData => ({
    type: "message",
    message: { role: "toolResult", toolCallId: "c", toolName, content: [{ type: "text", text: "" }], isError, timestamp: 0 },
    details,
  });
  it("finds the latest successful result's details of a tool, a plugin's custom data, and the latest prompt", () => {
    const events = log(
      user("first"),
      result("todo", { todos: [1] }),
      result("todo", { todos: [1, 2] }),
      result("todo", { todos: "broken" }, true),
      result("other", { x: 1 }),
      { type: "custom", kind: "notes.note", data: "a" },
      { type: "custom", kind: "other.thing", data: "b" },
      { type: "custom", kind: "notes.note", data: "c" },
      user("second"),
    );
    expect(latestDetails(events, "todo")).toEqual({ todos: [1, 2] });
    expect(latestDetails(events, "absent")).toBeUndefined();
    expect(customEvents(events, "notes.note")).toEqual(["a", "c"]);
    expect(lastPromptText(events)).toBe("second");
    expect(lastPromptText([])).toBeUndefined();
  });
});

describe("request reconstruction", () => {
  it("resolves omitted system and tools from earlier requests", () => {
    const tool = { name: "read", description: "Read", parameters: {} };
    const events = log(user("one"), request({ system: "SYS", tools: [tool] }), assistant("r1"), user("two"), request({ thinking: "high" }));
    expect(requestState(events)).toEqual({ model: "p/m", thinking: "high", system: "SYS", tools: [tool], contributions: [] });

    const second = rebuildRequest(events, "e5", "sid")!;
    expect(second.system).toBe("SYS");
    expect(second.tools).toEqual([tool]);
    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second.sessionId).toBe("sid");

    const first = rebuildRequest(events, "e2")!;
    expect(first.messages).toHaveLength(1);
    expect(rebuildRequest(events, "e1")).toBeUndefined();
  });

  it("is the request the constructor makes of the same fields, without its copy of every message", () => {
    // Made without the constructor's walk (`requestFrom`), which this holds to the constructor's result: an Effect
    // upgrade that gave a Schema class's instances more than their fields fails here.
    const tool = { name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } };
    const call: EventData = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
        api: "anthropic-messages",
        provider: "p",
        model: "m",
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 0,
      },
    };
    const result: EventData = {
      type: "message",
      message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export {}" }], isError: false, timestamp: 0 },
    };
    // As a store serves them: read back through the schema.
    const events = log(
      user("one"),
      request({ system: "SYS", tools: [tool], thinking: "high", providerOptions: { temperature: 0.2 } }),
      call,
      result,
      { type: "context", source: "notes", content: [{ type: "text", text: "a note" }] },
      request({ restart: "model", model: "p/other", thinking: "low", providerOptions: { temperature: 0.2 } }),
    ).map((event) => Schema.decodeUnknownSync(SessionEvent)(JSON.parse(JSON.stringify(event))));
    const rebuilt = rebuildRequest(events, "e6", "sid")!;
    const constructed = new LlmRequest({ ...rebuilt });
    expect(rebuilt).toBeInstanceOf(LlmRequest);
    expect(Object.keys(rebuilt)).toEqual(["model", "system", "messages", "thinkingFrom", "tools", "thinking", "sessionId", "providerOptions"]);
    expect(rebuilt.thinkingFrom).toBe(4);
    expect(isDeepStrictEqual(rebuilt, constructed)).toBe(true);
    expect(Equal.equals(rebuilt, constructed)).toBe(true);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(constructed));
    expect(String(rebuilt)).toBe(String(constructed));
  });
});

describe("contributions logged only when they change", () => {
  const read = { name: "read", description: "Read", parameters: {} };
  const bash = { name: "bash", description: "Run", parameters: {} };
  const credit = (env: string, tools: readonly (typeof read)[]): Contribution[] => [
    { source: "agent", kind: "system", label: "base", chars: 1 },
    { source: "agent", kind: "system", label: "env", chars: env.length },
    ...tools.map((tool): Contribution => ({ source: `tools.${tool.name}`, kind: "tool", label: tool.name, chars: 10 })),
  ];
  const first = credit("date 1", [read]);
  const more = credit("date 1", [read, bash]);
  const other = credit("date 22", [read]);
  /** A request: `logged`, the contributions it logs (none when undefined); `credited`, those an older agent logged. */
  type Ask = { readonly logged?: Contribution[]; readonly credited: Contribution[]; readonly extra?: Partial<Extract<EventData, { type: "request" }>> };
  const ask = ({ logged, extra }: Ask, older: boolean, credited: Contribution[]): EventData => {
    const { contributions: _, ...rest } = request(extra) as Extract<EventData, { type: "request" }>;
    return older ? { ...rest, contributions: credited } : logged === undefined ? rest : { ...rest, contributions: logged };
  };
  /**
   * Turns on two branches: the first's turns keep their contributions, through a compaction, then declare a tool more;
   * the sibling, written after it, credits other parts, and a request on the first branch after it credits the first's.
   * `older`: the log an agent that logged them on every request wrote.
   */
  const session = (older: boolean): SessionEvent[] => {
    const at = (spec: Ask) => ask(spec, older, spec.credited);
    return log(
      user("one"),
      at({ logged: first, credited: first, extra: { system: "B\n\ndate 1", tools: [read], restart: "start" } }),
      assistant("r1"),
      user("two"),
      at({ credited: first }),
      assistant("r2"),
      { type: "compaction", summary: "S", firstKeptId: "e4", tokensBefore: 10, source: "compaction" },
      at({ credited: first, extra: { restart: "compaction" } }),
      assistant("r3"),
      at({ logged: more, credited: more, extra: { tools: [read, bash], restart: "tools" } }),
      assistant("r4"),
      user("three"),
      at({ credited: more }),
      { data: at({ logged: other, credited: other, extra: { system: "B\n\ndate 22", tools: [read], restart: "start" } }), parent: "e1" },
      { data: assistant("s1"), parent: "e14" },
      { data: at({ credited: other }), parent: "e15" },
      { data: user("four"), parent: "e13" },
      at({ credited: more }),
    );
  };
  const requests = ["e2", "e5", "e8", "e10", "e13", "e14", "e16", "e18"];

  it("are the request's own, or the previous request's on its branch, never a sibling branch's", () => {
    const events = session(false);
    expect(events.filter((event) => event.data.type === "request" && event.data.contributions !== undefined).map((event) => event.id)).toEqual([
      "e2",
      "e10",
      "e14",
    ]);
    expect(requests.map((id) => requestState(branchOf(events, id)).contributions)).toEqual([first, first, first, more, more, other, other, more]);
    // A request with none before it on its branch credits nothing: its parts' plugins are not known.
    const orphan = log(user("one"), ask({ credited: first }, false, first));
    expect(requestState(orphan).contributions).toBeUndefined();
    expect(requestState(orphan).sections).toBeUndefined();
  });

  it("rebuild every request, and project every branch, as the log that repeats them on every request", () => {
    const events = session(false);
    const older = session(true);
    for (const leaf of ["e16", "e18"]) {
      const branch = branchOf(events, leaf);
      const before = branchOf(older, leaf);
      expect(trajectory(branch)).toEqual(trajectory(before));
      for (const id of requests.filter((request) => branch.some((event) => event.id === request))) {
        const upTo = (events: readonly SessionEvent[]) => events.slice(0, events.findIndex((event) => event.id === id) + 1);
        expect(rebuildRequest(branch, id, "sid"), id).toEqual(rebuildRequest(before, id, "sid"));
        expect(requestState(upTo(branch)), id).toEqual(requestState(upTo(before)));
      }
    }
  });
});

const thinker = (text: string): EventData => ({
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
      { type: "text", text },
    ],
    api: "anthropic-messages",
    provider: "p",
    model: "m",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 0,
  },
});
/** A request that declared `system`, made of the sections `parts` (id and text, from plugin `p`). */
const declared = (parts: readonly (readonly [string, string])[], extra: Partial<Extract<EventData, { type: "request" }>> = {}): EventData =>
  request({
    system: parts.map(([, text]) => text).join("\n\n"),
    contributions: parts.map(([id, text]) => ({ source: "p", kind: "system", label: id, chars: text.length })),
    restart: "start",
    ...extra,
  });
const promptUpdate = (sections: readonly (readonly [string, string])[], unavailable?: readonly string[]): EventData => ({
  type: "prompt-update",
  sections: sections.map(([id, text]) => ({ id, source: "p", text })),
  ...(unavailable === undefined ? {} : { unavailable }),
});
const texts = (messages: readonly Message[]) => messages.map((message) => (message.role === "toolResult" ? "" : contentText(message.content)));

describe("prompt-update events", () => {
  it("are the model's messages where they stand, saying each changed section and the tools refused", () => {
    const events = log(
      user("one"),
      declared([
        ["base", "B"],
        ["env", "date 1"],
      ]),
      assistant("r1"),
      promptUpdate(
        [
          ["env", "date 2"],
          ["notes", ""],
        ],
        ["bash"],
      ),
      user("two"),
    );
    const messages = deriveMessages(events);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"]);
    const update = texts(messages)[2]!;
    expect(update).toBe(promptUpdateText(events[3]!.data as Extract<EventData, { type: "prompt-update" }>));
    expect(update).toContain("not from the user");
    expect(update).toContain('<section id="env">\ndate 2\n</section>');
    expect(update).toContain('<section id="notes" removed="true"/>');
    expect(update).toContain("refused: bash.");
    expect(promptUpdateText({ type: "prompt-update", sections: [], unavailable: [] })).toContain("available again");
  });

  it("fold into the request state: sections as last told, and the tools refused until the prompt is declared again", () => {
    const events = log(
      user("one"),
      declared([
        ["base", "B"],
        ["env", "date 1"],
      ]),
      promptUpdate(
        [
          ["env", "date 2"],
          ["notes", "N"],
        ],
        ["bash"],
      ),
      request(),
    );
    expect(requestState(events).sections).toEqual([
      { id: "base", source: "p", text: "B" },
      { id: "env", source: "p", text: "date 2" },
      { id: "notes", source: "p", text: "N" },
    ]);
    expect(requestState(events).unavailable).toEqual(["bash"]);
    const again = log(
      ...events.map((event) => event.data),
      declared(
        [
          ["base", "B"],
          ["env", "date 2"],
        ],
        { restart: "tools" },
      ),
    );
    expect(requestState(again).sections).toEqual([
      { id: "base", source: "p", text: "B" },
      { id: "env", source: "p", text: "date 2" },
    ]);
    expect(requestState(again).unavailable).toBeUndefined();
  });

  it("are left out once a request declares the prompt again, and the rebuilt request says so too", () => {
    const events = log(
      user("one"),
      declared([["env", "date 1"]]),
      assistant("r1"),
      promptUpdate([["env", "date 2"]]),
      user("two"),
      declared([["env", "date 2"]], { restart: "tools" }),
    );
    expect(texts(deriveMessages(events))).toEqual(["one", "r1", "two"]);
    // Built for the restarting request itself: the update it says again is not shown before it either.
    expect(texts(rebuildRequest(events, "e6")!.messages)).toEqual(["one", "r1", "two"]);
    // A request before it saw the update.
    expect(texts(deriveMessages(events.slice(0, 5)))).toEqual(["one", "r1", texts(deriveMessages(events.slice(0, 4)))[2], "two"]);
  });
});

describe("thinkingFrom", () => {
  it("marks the thinking made before the latest request that declared the prompt afresh", () => {
    const events = log(
      user("one"),
      declared([["base", "B"]]),
      thinker("r1"),
      user("two"),
      declared([["base", "B"]], { restart: "model" }),
      thinker("r2"),
      user("three"),
    );
    expect(deriveHistory(events).thinkingFrom).toBe(3);
    expect(rebuildRequest(events, "e5")!.thinkingFrom).toBe(3);
    // Within the first prefix every thinking block was made under it.
    expect(deriveHistory(events.slice(0, 4)).thinkingFrom).toBeUndefined();
    expect(rebuildRequest(events, "e2")!.thinkingFrom).toBeUndefined();
  });

  it("is absent when nothing before the restart thinks", () => {
    const events = log(user("one"), declared([["base", "B"]]), assistant("r1"), declared([["base", "B"]], { restart: "model" }));
    expect(rebuildRequest(events, "e4")!.thinkingFrom).toBeUndefined();
  });

  it("counts the summary and the kept messages before a compaction's restart", () => {
    const events = log(
      user("one"),
      declared([["base", "B"]]),
      thinker("r1"),
      user("two"),
      thinker("r2"),
      { type: "compaction", summary: "S", firstKeptId: "e4", tokensBefore: 1, source: "c" },
      declared([["base", "B"]], { restart: "compaction" }),
    );
    const rebuilt = rebuildRequest(events, "e7")!;
    expect(texts(rebuilt.messages)).toEqual([expect.stringContaining("S"), "two", "r2"]);
    expect(rebuilt.thinkingFrom).toBe(3);
  });
});

describe("summaryText", () => {
  it("names the files the replaced history read and changed, after the summary", () => {
    const text = summaryText({
      type: "compaction",
      summary: "S",
      firstKeptId: "e1",
      tokensBefore: 1,
      source: "c",
      files: { read: ["a.ts"], modified: ["b.ts"] },
    });
    expect(text).toBe(
      "<summary>\nThe conversation so far, summarized:\n\nS\n\n<files>\nChanged:\n- b.ts\nRead:\n- a.ts\nRead a file again before relying on what the summary says of it.\n</files>\n</summary>",
    );
    expect(summaryText({ type: "compaction", summary: "S", firstKeptId: "e1", tokensBefore: 1, source: "c" })).toBe(
      "<summary>\nThe conversation so far, summarized:\n\nS\n</summary>",
    );
  });
});
