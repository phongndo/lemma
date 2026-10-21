import { describe, expect, it } from "vitest";
import type { EventData, SessionEvent, SessionInfo } from "@lemma/sessions";
import { agentOfCall, childrenOf, elapsed, groupStatus, isActive, outcomesOf, parseNotice, stateOf } from "../src/agents.ts";

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd: "/w", createdAt: 0, updatedAt: 0, lastSeq: 3, ...extra });
const branch = (...data: EventData[]): SessionEvent[] =>
  data.map((item, at) => ({ seq: at + 1, id: `e${at}`, parent: at === 0 ? null : `e${at - 1}`, at, data: item }));
const result = (toolName: string, details: unknown): EventData => ({
  type: "message",
  details,
  message: { role: "toolResult", toolCallId: "c", toolName, isError: false, timestamp: 0, content: [{ type: "text", text: "" }] },
});

describe("an agent's state", () => {
  it("is what it waits for, then whether it works, then whether it started, then how it ended", () => {
    const agent = session("a");
    expect(stateOf(agent, { running: true, waiting: "Needs input" })).toBe("waiting");
    expect(stateOf(agent, { running: true })).toBe("working");
    expect(stateOf(session("q", { lastSeq: 0 }), { running: false })).toBe("queued");
    // In the background, unheard: queued while its log holds only what its call made, else finished.
    expect(stateOf(session("b", { lastSeq: 1 }), { running: false }, { ended: "running", emptyAt: 1 })).toBe("queued");
    expect(stateOf(session("b", { lastSeq: 9 }), { running: false }, { ended: "running", emptyAt: 1 })).toBe("done");
    expect(stateOf(agent, { running: false }, { ended: "done" })).toBe("done");
    expect(stateOf(agent, { running: false }, { ended: "cancelled" })).toBe("stopped");
    expect(stateOf(agent, { running: false }, { ended: "timeout" })).toBe("stopped");
    expect(stateOf(agent, { running: false }, { ended: "error" })).toBe("failed");
    // Nothing said of it: finished.
    expect(stateOf(agent, { running: false })).toBe("done");
    expect(isActive("queued") && isActive("working") && isActive("waiting")).toBe(true);
    expect(isActive("done") || isActive("failed") || isActive("stopped")).toBe(false);
  });
});

describe("how a thread's agents finished", () => {
  it("reads each delegating call's result, a script's too, and each background agent's notice, the latest winning", () => {
    const outcomes = outcomesOf(
      branch(
        result("delegate", { sessionId: "a1", ended: "done", preview: "found it" }),
        result("delegate", { sessionId: "a2", ended: "running", background: true }),
        result("delegate", { sessionId: "a4", ended: "running", background: true, emptyAt: 1 }),
        result("codemode", {
          displays: [
            { name: "delegate", details: { sessionId: "a3", ended: "error", preview: "429" } },
            { name: "html_render", details: {} },
          ],
        }),
        {
          type: "context",
          source: "tools.delegate",
          requestId: "tools.delegate:c2",
          content: [{ type: "text", text: '<agent_result title="Two" session="a2" ended="cancelled">\nhalfway\n</agent_result>' }],
        },
      ),
    );
    expect(outcomes.get("a1")).toEqual({ ended: "done", preview: "found it" });
    // Running when its call answered; its notice says how it ended.
    expect(outcomes.get("a2")).toEqual({ ended: "cancelled", preview: "halfway" });
    expect(outcomes.get("a3")).toEqual({ ended: "error", preview: "429" });
    // Not heard from yet: running, and where its prompt waited for a slot.
    expect(outcomes.get("a4")).toEqual({ ended: "running", emptyAt: 1 });
  });

  it("reads a notice back, and nothing from text that is none", () => {
    expect(parseNotice('<agent_result title="Map it" session="s1" ended="done">\nThe answer\nin two lines\n</agent_result>')).toEqual({
      title: "Map it",
      session: "s1",
      ended: "done",
      body: "The answer\nin two lines",
    });
    expect(parseNotice("A command exited.")).toBeUndefined();
  });
});

describe("a thread's agents", () => {
  it("are the sessions it started, oldest first; a call's is found by its parent link", () => {
    const list = [
      session("b", { createdAt: 2, parent: { sessionId: "p", toolCallId: "c2" } }),
      session("a", { createdAt: 1, parent: { sessionId: "p", toolCallId: "c1" } }),
      session("x", { createdAt: 3, parent: { sessionId: "other" } }),
      session("p"),
    ];
    expect(childrenOf(list, "p").map((agent) => agent.id)).toEqual(["a", "b"]);
    expect(childrenOf(list, undefined)).toEqual([]);
    expect(agentOfCall(list, "p", "c2")?.id).toBe("b");
    expect(agentOfCall(list, "other", "c2")).toBeUndefined();
  });

  it("sum up as a group: the active first, else how they finished", () => {
    expect(groupStatus(["working", "queued", "done"])).toEqual({ label: "2 working", active: true });
    expect(groupStatus(["working", "waiting"])).toEqual({ label: "1 working, 1 needs input", active: true });
    expect(groupStatus(["done", "done"])).toEqual({ label: "All finished", active: false });
    expect(groupStatus(["done", "failed", "stopped"])).toEqual({ label: "1 failed, 1 stopped", active: false });
  });

  it("count their time shortly", () => {
    expect(elapsed(0, 12_000)).toBe("12s");
    expect(elapsed(0, 3 * 60_000)).toBe("3m");
    expect(elapsed(0, 78 * 60_000)).toBe("1h 18m");
  });
});
