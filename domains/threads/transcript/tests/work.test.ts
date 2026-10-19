import { describe, expect, it } from "vitest";
import type { EventData } from "@lemma/sessions";
import { displayedCalls, summarizeTools, workEntries } from "../src/work.ts";
import type { ActionOf, WorkEntry } from "../src/work.ts";
import { assistant, branch, toolResult, transcriptOf, user } from "@lemma/threads/testing";

/** As the bundled tools' views say; `grep` stands for a tool of a plugin's own. */
const ACTIONS: ReadonlyMap<string, readonly [string, string, string]> = new Map([
  ["bash", ["ran", "command", "commands"]],
  ["read", ["read", "file", "files"]],
  ["edit", ["changed", "file", "files"]],
  ["write", ["changed", "file", "files"]],
  ["grep", ["searched", "time", "times"]],
]);
const actionOf: ActionOf = (name) => ACTIONS.get(name);
const call = (id: string, name = "bash") => ({ type: "toolCall" as const, id, name, arguments: { command: "ls" } });
const itemsOf = (...data: EventData[]) =>
  transcriptOf(branch({ type: "turn-start", turnId: "t1" }, user("hi", "t1"), ...data)).turns[0]!.items.filter((item) => item.kind !== "user");
const shape = (entries: readonly WorkEntry[]) =>
  entries.map((entry) =>
    entry.kind === "group"
      ? { group: entry.summary, rows: entry.rows.map((row) => (row.kind === "block" ? row.block.kind : row.item.kind)) }
      : entry.kind === "block"
        ? entry.block.kind
        : entry.item.kind,
  );

describe("summarizeTools", () => {
  it("says what the calls did, naming two kinds and counting the rest", () => {
    expect(summarizeTools(["bash", "bash", "edit", "bash"], actionOf)).toBe("Ran 3 commands and changed 1 file");
    expect(summarizeTools(["read", "read", "bash", "grep", "find", "mcp"], actionOf)).toBe("Read 2 files, ran 1 command, and 3 other actions");
    expect(summarizeTools(["mcp", "web"], actionOf)).toBe("Used 2 tools");
    // A tool may be named anything, a name objects have too among them.
    expect(summarizeTools(["constructor", "toString", "bash"], actionOf)).toBe("Ran 1 command and 2 other actions");
  });

  it("counts calls whose tools say the same words as one kind", () => {
    expect(summarizeTools(["edit", "write"], actionOf)).toBe("Changed 2 files");
  });
});

describe("workEntries", () => {
  it("gathers calls made one after another, with thoughts between, until a remark", () => {
    const items = itemsOf(
      { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "thinking", thinking: "hm" }, call("c1")]) },
      toolResult("c1", "ok"),
      { type: "message", turnId: "t1", stepId: "s2", message: assistant([call("c2", "edit")]) },
      toolResult("c2", "boom", { isError: true }),
      { type: "message", turnId: "t1", stepId: "s3", message: assistant([{ type: "text", text: "Now the tests." }, call("c3")]) },
      toolResult("c3", "ok"),
      { type: "message", turnId: "t1", stepId: "s4", message: assistant([{ type: "thinking", thinking: "next" }]) },
    );
    const entries = workEntries(items, actionOf);
    expect(shape(entries)).toEqual([{ group: "Ran 1 command and changed 1 file", rows: ["thinking", "tool", "tool"] }, "text", "tool", "thinking"]);
    expect(entries[0]).toMatchObject({ kind: "group", failed: 1, tools: ["bash", "edit"] });
  });

  it("keys a group by its first row, so it keeps its key as the run grows", () => {
    const one = workEntries(itemsOf({ type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1"), call("c2")]) }), actionOf);
    const two = workEntries(
      itemsOf(
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1"), call("c2")]) },
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([call("c3")]) },
      ),
      actionOf,
    );
    expect(two[0]!.key).toBe(one[0]!.key);
  });
});

describe("displayedCalls", () => {
  it("picks the calls whose view shows something outside the fold, once each has a result, in order", () => {
    const items = itemsOf(
      { type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1", "html_render"), call("c2")]) },
      toolResult("c1", "shown"),
      toolResult("c2", "ok"),
      { type: "message", turnId: "t1", stepId: "s2", message: assistant([call("c3", "html_render"), call("c4", "html_render")]) },
      toolResult("c4", "shown"),
    );
    const shows = (name: string) => name === "html_render";
    // c3 has no result yet (it runs), so it shows nothing yet.
    expect(displayedCalls(items, shows).map((block) => block.call.id)).toEqual(["c1", "c4"]);
    expect(displayedCalls(items, () => false)).toEqual([]);
  });
});
