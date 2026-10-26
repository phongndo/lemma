import { Effect } from "effect";
import type { Context } from "effect";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolCall, ToolSpec } from "@lemma/llm";
import { emptyUsage } from "@lemma/llm";
import type { EventData, RequestState, SessionEvent, Sessions } from "@lemma/sessions";
import { TurnLog, unansweredCalls } from "../../src/kit/turn/log.ts";
import { promptUpdate, restartOf } from "../../src/kit/turn/request.ts";
import { toolLoop } from "../../src/kit/turn/steps.ts";
import { nextGroup } from "../../src/kit/turn/tools.ts";

/*
 * The parts of a turn that decide something on their own, without a host: the rest is the agent's tests'
 * (`domains/agent/loop/tests`), which run whole turns.
 */

const spec = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object", properties: {} } });
const event = (id: string, parent: string | null, data: EventData): SessionEvent => ({ seq: 0, id, parent, at: 0, data });
const answer = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant",
  content,
  api: "fake",
  provider: "fake",
  model: "m",
  usage: emptyUsage,
  stopReason,
  timestamp: 1,
});
const call = (id: string, name = "read"): ToolCall => ({ type: "toolCall", id, name, arguments: {} });

/** What a request that declared `tools` told the model, for a request after it to extend. */
const declared = (tools: readonly ToolSpec[], extra: Partial<RequestState> = {}): RequestState => ({
  model: "p/m",
  system: "Be brief.",
  sections: [{ id: "base", source: "agent.loop", text: "Be brief." }],
  contributions: [{ source: "agent.loop", kind: "system", label: "base", chars: 9 }],
  tools,
  ...extra,
});

describe("a request after another", () => {
  const read = spec("read");
  const request = event("r", null, { type: "request", turnId: "t", stepId: "s", model: "p/m", composition: "c" });

  it("extends it, unless it asks another model, declares a tool it did not, or follows a compaction or an edit", () => {
    expect(restartOf([request], declared([read]), "p/m", [read])).toBeUndefined();
    // Fewer tools extend it too: the one left out is refused, not undeclared.
    expect(restartOf([request], declared([read, spec("bash")]), "p/m", [read])).toBeUndefined();
    expect(restartOf([request], declared([read]), "p/other", [read])).toBe("model");
    expect(restartOf([request], declared([read]), "p/m", [read, spec("bash")])).toBe("tools");
    expect(restartOf([request], declared([read]), "p/m", [{ ...read, description: "changed" }])).toBe("tools");
    const compacted = event("c", "r", { type: "compaction", summary: "s", firstKeptId: "r", tokensBefore: 1, source: "x" });
    expect(restartOf([request, compacted], declared([read]), "p/m", [read])).toBe("compaction");
    expect(restartOf([], {}, "p/m", [read])).toBe("start");
  });

  it("tells the model the sections that changed or went, and the declared tools it no longer offers", () => {
    const previous = declared([spec("read"), spec("bash")], {
      sections: [
        { id: "base", source: "agent.loop", text: "Be brief." },
        { id: "skills", source: "skills.files", text: "Skills." },
      ],
    });
    const base = { id: "base", source: "agent.loop", text: "Be brief." };
    expect(promptUpdate(previous, [base, { id: "skills", source: "skills.files", text: "Skills." }], ["read", "bash"])).toBeUndefined();
    expect(promptUpdate(previous, [{ ...base, text: "Be thorough." }], ["read"])).toEqual({
      sections: [
        { id: "base", source: "agent.loop", text: "Be thorough." },
        { id: "skills", source: "skills.files", text: "" },
      ],
      unavailable: ["bash"],
    });
    // Told already: no tool to tell of again.
    expect(promptUpdate({ ...previous, unavailable: ["bash"] }, [base, { id: "skills", source: "skills.files", text: "Skills." }], ["read"])).toBeUndefined();
  });
});

describe("the default decision", () => {
  it("goes on while the model asked for tools or has results to read, and stops otherwise, saying why", () => {
    expect(toolLoop({ message: answer([call("c1")], "toolUse"), results: [] })).toEqual({ result: "continue", why: "the model asked for tools" });
    const result = { role: "toolResult" as const, toolCallId: "c1", toolName: "read", content: [], isError: false, timestamp: 1 };
    expect(toolLoop({ message: answer([], "stop"), results: [result] })).toEqual({ result: "continue", why: "tool results to read" });
    expect(toolLoop({ message: answer([], "length"), results: [] })).toEqual({ result: "stop", why: "the model stopped (length)" });
  });
});

describe("tool calls that run together", () => {
  const together = (call: ToolCall) => call.name === "read";

  it("are the first call alone, or it and those right after it whose tools run together, up to the limit", () => {
    const calls = [call("a"), call("b"), call("c", "bash"), call("d")];
    expect(nextGroup(calls, together, 8).map((each) => each.id)).toEqual(["a", "b"]);
    expect(nextGroup(calls, together, 1).map((each) => each.id)).toEqual(["a"]);
    expect(nextGroup(calls.slice(2), together, 8).map((each) => each.id)).toEqual(["c"]);
  });
});

describe("the turn's log", () => {
  /** A store that appends where it is told and reads a branch back by parents. */
  const store = () => {
    const events: SessionEvent[] = [];
    let next = 0;
    const sessions = {
      append: (_sessionId: string, data: EventData, options?: { readonly parent?: string }) =>
        Effect.sync(() => {
          const appended = event(`e${++next}`, options?.parent ?? events.at(-1)?.id ?? null, data);
          events.push(appended);
          return appended;
        }),
      branch: (_sessionId: string, options?: { readonly leaf?: string }) =>
        Effect.sync(() => {
          const path: SessionEvent[] = [];
          for (let at = events.find((each) => each.id === options?.leaf); at !== undefined; at = events.find((each) => each.id === at!.parent))
            path.unshift(at);
          return path;
        }),
    } as unknown as Context.Service.Shape<typeof Sessions>;
    return { events, sessions };
  };

  it("chains each append after the turn's last event, keeping the branch they make", async () => {
    const { sessions } = store();
    const log = new TurnLog(sessions, "s1");
    log.keep([]);
    await Effect.runPromise(log.append({ type: "turn-start", turnId: "t" }));
    await Effect.runPromise(log.append({ type: "step-start", turnId: "t", stepId: "s" }));
    expect(log.branch?.map((each) => each.parent)).toEqual([null, "e1"]);
    expect(log.lastId).toBe("e2");
  });

  it("reads the branch back when an append does not chain onto the one it keeps", async () => {
    const { sessions } = store();
    const log = new TurnLog(sessions, "s1");
    await Effect.runPromise(log.append({ type: "turn-start", turnId: "t" }));
    expect(log.branch).toBeUndefined();
    expect((await Effect.runPromise(log.branchNow)).map((each) => each.id)).toEqual(["e1"]);
    expect(log.request).toEqual({});
  });

  it("finds the calls a branch left without a result", () => {
    const asked = event("a", null, { type: "message", turnId: "t", stepId: "s", message: answer([call("c1"), call("c2")], "toolUse") });
    const result = event("b", "a", {
      type: "message",
      turnId: "t",
      stepId: "s",
      message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false, timestamp: 1 },
    });
    expect(unansweredCalls([asked, result])?.calls.map((each) => each.id)).toEqual(["c2"]);
    expect(unansweredCalls([asked])?.event).toBe(asked);
    expect(unansweredCalls([event("u", null, { type: "message", message: { role: "user", content: [], timestamp: 1 } })])).toBeUndefined();
  });
});
