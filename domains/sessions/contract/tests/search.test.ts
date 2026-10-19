import { describe, expect, test } from "vitest";
import { searchLog, searchWords, snippetAt } from "../src/search.ts";
import type { SessionEvent } from "../src/sessions.ts";

let seq = 0;
const said = (role: "user" | "assistant", text: string): SessionEvent => {
  seq++;
  const message =
    role === "user"
      ? { role, content: [{ type: "text" as const, text }], timestamp: 0 }
      : {
          role,
          content: [{ type: "text" as const, text }],
          api: "test",
          provider: "test",
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: 0,
        };
  return { seq, id: `e${seq}`, parent: null, at: seq, data: { type: "message", message } as SessionEvent["data"] };
};

describe("searching a log", () => {
  const log = [
    said("user", "Why does the parser drop trailing commas?"),
    said("assistant", "The parser stops at the first comma it cannot place."),
    said("user", "Fix the lexer"),
  ];

  test("every word, in any case, in the newest prompt or reply holding them all", () => {
    expect(searchLog("s", log, searchWords("PARSER comma"))).toMatchObject({ eventId: "e2", role: "assistant" });
    expect(searchLog("s", log, searchWords("trailing parser"))).toMatchObject({ eventId: "e1", role: "user" });
    expect(searchLog("s", log, searchWords("parser lexer"))).toBeUndefined();
    expect(searchLog("s", log, searchWords("   "))).toBeUndefined();
  });

  test("a snippet is one line around the first match, cut at word ends", () => {
    const text = `${"word ".repeat(30)}the match\nis here ${"more ".repeat(40)}`;
    const snippet = snippetAt(text, text.indexOf("match"));
    expect(snippet.startsWith("…word")).toBe(true);
    expect(snippet).toContain("the match is here");
    expect(snippet.endsWith("more…")).toBe(true);
    expect(snippetAt("short one", 0)).toBe("short one");
    // A match inside a long word stays: the cut goes into the word rather than past the match.
    const path = "Edit the file at src/components/very/deep/folder/parser.ts so that it handles trailing commas";
    expect(snippetAt(path, path.indexOf("parser"), "parser".length)).toBe("…ts/very/deep/folder/parser.ts so that it handles trailing commas");
    expect(searchLog("s", [said("user", path)], searchWords("parser"))?.snippet).toContain("parser");
  });
});
