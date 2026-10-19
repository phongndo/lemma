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

const asRoot = process.getuid?.() === 0;
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

  it("falls back as pi does: trailing whitespace and Unicode quotes, dashes, and spaces normalized, other lines left as they were", async () => {
    await put("ws.ts", "const a = 1;  \nconst b = 2;\t\nconst c = 3; \n");
    const spaced = await call(
      editTool,
      { path: "ws.ts", edits: [{ oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 20;" }] },
      context(dir),
    );
    expect(textOf(spaced)).toBe("Successfully replaced 1 block(s) in ws.ts.");
    // The lines the edit covers are written as normalized; the line it did not cover keeps its bytes.
    expect(await get("ws.ts")).toBe("const a = 1;\nconst b = 20;\nconst c = 3; \n");

    await put("quotes.py", "print(“hi”)\nx = 1 — 2\nend\n");
    await call(
      editTool,
      {
        path: "quotes.py",
        edits: [
          { oldText: "end", newText: "done" },
          { oldText: "x = 1 - 2", newText: "x = 1 + 2" },
        ],
      },
      context(dir),
    );
    expect(await get("quotes.py")).toBe("print(“hi”)\nx = 1 + 2\ndone\n");
  });

  it("requires a fallback match to be unique among the normalized text", async () => {
    await put("f.txt", "x = 1 \ny\nx = 1\t\ny\n");
    expect(await attempt(editTool, { path: "f.txt", edits: [{ oldText: "x = 1\ny", newText: "z" }] }, context(dir))).toContain(
      "Found 2 occurrences of the text in f.txt. The text must be unique.",
    );
    expect(await get("f.txt")).toBe("x = 1 \ny\nx = 1\t\ny\n");
  });

  it("counts occurrences as pi does, without overlaps", async () => {
    // "}\n}\n" is in "}\n}\n}\n" twice, overlapping: counted once, so the first is replaced.
    await put("f.txt", "}\n}\n}\n");
    await call(editTool, { path: "f.txt", edits: [{ oldText: "}\n}\n", newText: "x\n" }] }, context(dir));
    expect(await get("f.txt")).toBe("x\n}\n");
    await put("g.txt", "aaaa");
    expect(await attempt(editTool, { path: "g.txt", edits: [{ oldText: "aa", newText: "b" }] }, context(dir))).toContain(
      "Found 2 occurrences of the text in g.txt",
    );
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

  it("reports a directory, a missing parent, no edits, and an unwritable file", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    expect(await attempt(editTool, { path: "sub", edits: [{ oldText: "a", newText: "b" }] }, context(dir))).toBe(
      "error: Could not edit file: sub is a directory, not a file. Use bash (ls) to list it.",
    );
    expect(await attempt(editTool, { path: "gone/f.txt", edits: [{ oldText: "a", newText: "b" }] }, context(dir))).toBe(
      "error: Could not edit file: File not found: gone/f.txt",
    );
    expect(await attempt(editTool, { path: "f.txt", edits: [] }, context(dir))).toContain("edits must contain at least one replacement");
    if (asRoot) return;
    await put("ro.txt", "a");
    await fs.chmod(path.join(dir, "ro.txt"), 0o444);
    expect(await attempt(editTool, { path: "ro.txt", edits: [{ oldText: "a", newText: "b" }] }, context(dir))).toBe(
      "error: Could not edit file: Permission denied: ro.txt",
    );
    expect(await get("ro.txt")).toBe("a");
  });

  it("keeps the file's mode and edits a symlink's target, leaving the link", async () => {
    await put("run.sh", "echo old\n");
    await fs.chmod(path.join(dir, "run.sh"), 0o755);
    await fs.symlink("run.sh", path.join(dir, "link.sh"));
    await call(editTool, { path: "link.sh", edits: [{ oldText: "old", newText: "new" }] }, context(dir));
    expect(await get("run.sh")).toBe("echo new\n");
    expect((await fs.lstat(path.join(dir, "link.sh"))).isSymbolicLink()).toBe(true);
    expect((await fs.stat(path.join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it.skipIf(asRoot)("edits a file in place when its directory takes no new name", async () => {
    await fs.mkdir(path.join(dir, "locked"));
    await put("locked/f.txt", "keep me");
    // The file is writable but its directory takes no new name, so no replacement can be made beside it.
    await fs.chmod(path.join(dir, "locked"), 0o500);
    try {
      expect(await attempt(editTool, { path: "locked/f.txt", edits: [{ oldText: "keep", newText: "lose" }] }, context(dir))).toBe(
        "ok: Successfully replaced 1 block(s) in locked/f.txt.",
      );
      expect(await get("locked/f.txt")).toBe("lose me");
      expect(await fs.readdir(path.join(dir, "locked"))).toEqual(["f.txt"]);
    } finally {
      await fs.chmod(path.join(dir, "locked"), 0o700);
    }
  });

  it("runs concurrent edits to one file one at a time, each against the file the last one left", async () => {
    await put("f.txt", "alpha\nbeta\ngamma\n");
    // Disjoint edits all land: none reads the file before the one ahead of it has written.
    await Promise.all(
      ["alpha", "beta", "gamma"].map((word) => call(editTool, { path: "f.txt", edits: [{ oldText: word, newText: word.toUpperCase() }] }, context(dir))),
    );
    expect(await get("f.txt")).toBe("ALPHA\nBETA\nGAMMA\n");

    // The same edit through two names: whichever runs second sees the first's result, finds nothing, and changes nothing.
    await fs.symlink("f.txt", path.join(dir, "alias.txt"));
    const results = await Promise.all(
      ["f.txt", "alias.txt"].map((name) => attempt(editTool, { path: name, edits: [{ oldText: "BETA", newText: `beta via ${name}` }] }, context(dir))),
    );
    expect(results.filter((result) => result.startsWith("ok:"))).toHaveLength(1);
    expect(results.filter((result) => result.startsWith("error: Could not find the exact text"))).toHaveLength(1);
    expect(await get("f.txt")).toMatch(/^ALPHA\nbeta via (f|alias)\.txt\nGAMMA\n$/);
  });
});
