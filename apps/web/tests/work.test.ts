import { describe, expect, it } from "vitest";
import type { EventData } from "@lemma/contracts";
import { summarizeTools, workEntries } from "../src/model/work.ts";
import type { WorkEntry } from "../src/model/work.ts";
import { assistant, branch, toolResult, transcriptOf, user } from "./fixtures.ts";

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
    expect(summarizeTools(["bash", "bash", "edit", "bash"])).toBe("Ran 3 commands and changed 1 file");
    expect(summarizeTools(["read", "read", "bash", "grep", "find", "mcp"])).toBe("Read 2 files, ran 1 command, and 3 other actions");
    expect(summarizeTools(["edit", "write"])).toBe("Changed 2 files");
    expect(summarizeTools(["mcp", "web"])).toBe("Used 2 tools");
    // A tool may be named anything, a name objects have too among them.
    expect(summarizeTools(["constructor", "toString", "bash"])).toBe("Ran 1 command and 2 other actions");
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
    const entries = workEntries(items);
    expect(shape(entries)).toEqual([{ group: "Ran 1 command and changed 1 file", rows: ["thinking", "tool", "tool"] }, "text", "tool", "thinking"]);
    expect(entries[0]).toMatchObject({ kind: "group", failed: 1, tools: ["bash", "edit"] });
  });

  it("keys a group by its first row, so it keeps its key as the run grows", () => {
    const one = workEntries(itemsOf({ type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1"), call("c2")]) }));
    const two = workEntries(
      itemsOf(
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([call("c1"), call("c2")]) },
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([call("c3")]) },
      ),
    );
    expect(two[0]!.key).toBe(one[0]!.key);
  });
});
