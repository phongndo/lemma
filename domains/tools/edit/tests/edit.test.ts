import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool } from "../src/index.ts";
import type { EditDetails } from "../src/index.ts";
import { attempt, call, context, tempDir, textOf } from "@lemma/tools/testing";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const put = (name: string, content: string | Buffer) => fs.writeFile(path.join(dir, name), content);
const get = (name: string) => fs.readFile(path.join(dir, name), "utf8");

describe("edit", () => {
  it("replaces unique text and returns a unified patch", async () => {
    await put("f.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
    const result = await call(
      editTool,
      {
        path: "f.ts",
        edits: [
          { oldText: "b\n", newText: "B\n" },
          { oldText: "i", newText: "I" },
        ],
      },
      context(dir),
    );
    expect(textOf(result)).toBe("Successfully replaced 2 block(s) in f.ts.");
    expect(await get("f.ts")).toBe("a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n");
    const details = result.details as EditDetails;
    expect(details.firstChangedLine).toBe(2);
    expect(details.patch).toBe(
      ["--- f.ts", "+++ f.ts", "@@ -1,10 +1,10 @@", " a", "-b", "+B", " c", " d", " e", " f", " g", " h", "-i", "+I", " j", ""].join("\n"),
    );
  });

  it("refuses missing, ambiguous, overlapping, empty, and no-op edits without touching the file", async () => {
    await put("f.txt", "foo bar foo\nbaz\n");
    const tryEdit = (edits: unknown) => attempt(editTool, { path: "f.txt", edits }, context(dir));
    expect(await tryEdit([{ oldText: "nope", newText: "x" }])).toContain("Could not find the exact text in f.txt");
    expect(await tryEdit([{ oldText: "foo", newText: "x" }])).toContain("Found 2 occurrences of the text in f.txt");
    expect(
      await tryEdit([
        { oldText: "bar foo", newText: "x" },
        { oldText: "foo\nbaz", newText: "y" },
      ]),
    ).toContain("edits[0] and edits[1] overlap");
    expect(await tryEdit([{ oldText: "", newText: "x" }])).toContain("oldText must not be empty");
    expect(await tryEdit([{ oldText: "baz", newText: "baz" }])).toContain("No changes made");
    expect(
      await tryEdit([
        { oldText: "baz", newText: "q" },
        { oldText: "zzz", newText: "q" },
      ]),
    ).toContain("Could not find edits[1]");
    expect(await get("f.txt")).toBe("foo bar foo\nbaz\n");
  });

  it("counts overlapping occurrences as ambiguous", async () => {
    await put("f.txt", "}\n}\n}\n");
    expect(await attempt(editTool, { path: "f.txt", edits: [{ oldText: "}\n}\n", newText: "x" }] }, context(dir))).toContain(
      "Found 2 occurrences of the text in f.txt",
    );
    await put("g.txt", "aaaa");
    expect(await attempt(editTool, { path: "g.txt", edits: [{ oldText: "aa", newText: "b" }] }, context(dir))).toContain(
      "Found 3 occurrences of the text in g.txt",
    );
    expect(await get("f.txt")).toBe("}\n}\n}\n");
    expect(await get("g.txt")).toBe("aaaa");
  });

  it("accepts the legacy and stringified shapes models send", async () => {
    await put("f.txt", "one two three");
    await call(editTool, { path: "f.txt", oldText: "one", newText: "1" }, context(dir));
    await call(editTool, { path: "f.txt", edits: JSON.stringify([{ oldText: "two", newText: "2" }]) }, context(dir));
    await call(editTool, { path: "f.txt", edits: { oldText: "three", newText: "3" } }, context(dir));
    expect(await get("f.txt")).toBe("1 2 3");
  });

  it("matches LF text in CRLF files and preserves line endings and BOM", async () => {
    await put("win.txt", "﻿first\r\nsecond\r\nthird\r\n");
    await call(editTool, { path: "win.txt", edits: [{ oldText: "first\nsecond", newText: "1st\n2nd" }] }, context(dir));
    expect(await get("win.txt")).toBe("﻿1st\r\n2nd\r\nthird\r\n");
  });

  it("reports a missing file", async () => {
    expect(await attempt(editTool, { path: "none.txt", edits: [{ oldText: "a", newText: "b" }] }, context(dir))).toBe(
      "error: Could not edit file: File not found: none.txt",
    );
  });
});
