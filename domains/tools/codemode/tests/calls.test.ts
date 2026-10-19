import { describe, expect, it } from "vitest";
import { firstLine, liveCalls, scriptOutput } from "../src/calls.ts";

describe("a codemode call in the chat", () => {
  it("is named by its script's first line, past its options line", () => {
    expect(firstLine('// @options: {"timeout_ms": 1000}\n\n  const r = await tools.bash({ command: "ls" });\nreturn r;')).toBe(
      'const r = await tools.bash({ command: "ls" });',
    );
    expect(firstLine("x".repeat(200))).toHaveLength(120);
    expect(firstLine("  \n")).toBeUndefined();
    expect(firstLine(undefined)).toBeUndefined();
  });

  it("lists the calls a running script printed, as the host prints them", () => {
    const output = ['✓ bash 12ms {"command":"ls"}', "✗ read 3ms {}", "– slow 5000ms", "✓ count 0ms {} (from before the restart)", "stray text"].join("\n");
    expect(liveCalls(output)).toEqual([
      { name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 12 },
      { name: "read", args: "{}", status: "error", durationMs: 3 },
      { name: "slow", status: "cancelled", durationMs: 5000 },
      { name: "count", args: "{}", status: "ok", durationMs: 0, replayed: true },
    ]);
    expect(liveCalls(undefined)).toEqual([]);
  });

  it("shows what a script printed without the result's header, from its first line", () => {
    const header = (ended: string) => ({ type: "text", text: `Script ${ended}\nWall time 1.5 seconds\nOutput:\n` });
    expect(scriptOutput([header("completed"), { type: "text", text: "[Image saved to /tmp/a.png]" }, { type: "image" }, { type: "text", text: "done" }])).toBe(
      "[Image saved to /tmp/a.png]\ndone",
    );
    expect(scriptOutput([header("completed (resumed after a host restart)"), { type: "text", text: "42" }])).toBe("42");
    expect(scriptOutput([header("failed"), { type: "text", text: "Script error:\nError: x" }])).toBe("Script error:\nError: x");
    expect(scriptOutput([{ type: "text", text: "no header" }])).toBe("no header");
  });
});
