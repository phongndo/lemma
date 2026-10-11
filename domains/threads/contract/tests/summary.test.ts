import { describe, expect, it } from "vitest";
import { partialStringField, summarizeArgs, truncateLines } from "../src/summary.ts";

describe("summary", () => {
  it("summarizes a call by its first short string argument", () => {
    expect(summarizeArgs({ n: 1, q: "hello" })).toEqual({ primary: "hello" });
    expect(summarizeArgs({ body: "two\nlines", q: "x".repeat(201) })).toEqual({});
    expect(summarizeArgs(undefined)).toEqual({});
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
