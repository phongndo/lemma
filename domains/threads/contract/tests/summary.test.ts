import { describe, expect, it } from "vitest";
import { partialStringField, summarizeToolArgs, truncateLines } from "../src/summary.ts";

describe("summary", () => {
  it("summarizes built-in tool arguments", () => {
    expect(summarizeToolArgs("bash", { command: "ls -la" })).toEqual({ primary: "ls -la", shell: true });
    expect(summarizeToolArgs("read", { path: "/w/a.ts", offset: 10, limit: 5 }, { cwd: "/w" })).toEqual({
      primary: "a.ts",
      secondary: "lines 10–14",
      file: { path: "a.ts", kind: "file" },
    });
    expect(summarizeToolArgs("ls", { path: "/w/src" }, { cwd: "/w" })).toEqual({ primary: "src", file: { path: "src", kind: "directory" } });
    expect(summarizeToolArgs("grep", { pattern: "TODO", path: "/w/src" }, { cwd: "/w" })).toEqual({ primary: "TODO", secondary: "in src" });
    expect(summarizeToolArgs("custom", { n: 1, q: "hello" })).toEqual({ primary: "hello" });
    expect(summarizeToolArgs("custom", undefined)).toEqual({});
  });

  it("reads string fields from partial JSON", () => {
    expect(partialStringField('{"command":"echo \\"hi', "command")).toBe('echo "hi');
    expect(partialStringField('{"command":"a\\', "command")).toBe("a");
    expect(partialStringField('{"com', "command")).toBeUndefined();
  });

  it("truncates lines", () => {
    expect(truncateLines("a\nb\nc", 2)).toEqual({ text: "a\nb", hidden: 1 });
    expect(truncateLines("a", 2)).toEqual({ text: "a", hidden: 0 });
  });
});
