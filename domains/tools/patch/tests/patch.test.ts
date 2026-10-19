import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchTool } from "../src/index.ts";
import type { PatchDetails } from "../src/index.ts";
import { attempt, call, context, tempDir, textOf } from "@lemma/tools/testing";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const asRoot = process.getuid?.() === 0;
const at = (name: string) => path.join(dir, name);
const put = async (name: string, content: string) => {
  await fs.mkdir(path.dirname(at(name)), { recursive: true });
  await fs.writeFile(at(name), content);
};
const get = (name: string) => fs.readFile(at(name), "utf8");
const exists = (name: string) =>
  fs.access(at(name)).then(
    () => true,
    () => false,
  );
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const apply = (input: string) => call(patchTool, { input }, context(dir));
const tryApply = (input: string) => attempt(patchTool, { input }, context(dir));

describe("apply_patch", () => {
  it("adds, updates, moves, and deletes files in one patch, with Codex's summary and a diff of each", async () => {
    await put("src/app.py", "import os\n\ndef greet():\n    print('Hi')\n    return 1\n");
    await put("old.txt", "gone\n");
    await put("name.txt", "keep\nchange\n");
    const result = await apply(
      patch(
        "*** Delete File: old.txt",
        "*** Add File: src/new/hello.txt",
        "+Hello",
        "*** Update File: src/app.py",
        "@@ def greet():",
        "-    print('Hi')",
        "+    print('Hello')",
        "     return 1",
        "*** Update File: name.txt",
        "*** Move to: renamed/name.txt",
        " keep",
        "-change",
        "+changed",
      ),
    );
    // Added, then changed (a moved file by where it went), then deleted.
    expect(textOf(result)).toBe(["Success. Updated the following files:", "A src/new/hello.txt", "M src/app.py", "M renamed/name.txt", "D old.txt"].join("\n"));
    expect(await get("src/new/hello.txt")).toBe("Hello\n");
    expect(await get("src/app.py")).toBe("import os\n\ndef greet():\n    print('Hello')\n    return 1\n");
    expect(await get("renamed/name.txt")).toBe("keep\nchanged\n");
    expect(await exists("name.txt")).toBe(false);
    expect(await exists("old.txt")).toBe(false);

    const details = result.details as PatchDetails;
    expect(details.files.map(({ change, path: file, movedTo, firstChangedLine }) => ({ change, file, movedTo, firstChangedLine }))).toEqual([
      { change: "delete", file: at("old.txt"), movedTo: undefined, firstChangedLine: undefined },
      { change: "add", file: at("src/new/hello.txt"), movedTo: undefined, firstChangedLine: 1 },
      { change: "update", file: at("src/app.py"), movedTo: undefined, firstChangedLine: 4 },
      { change: "move", file: at("name.txt"), movedTo: at("renamed/name.txt"), firstChangedLine: 2 },
    ]);
    expect(details.files[0]!.patch).toBe("--- old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n");
    expect(details.files[1]!.patch).toBe("--- /dev/null\n+++ src/new/hello.txt\n@@ -0,0 +1,1 @@\n+Hello\n");
    expect(details.files[3]!.patch).toBe("--- name.txt\n+++ renamed/name.txt\n@@ -1,2 +1,2 @@\n keep\n-change\n+changed\n");
    expect(details.patch).toBe(details.files.map((file) => file.patch).join(""));
  });

  it("changes nothing when any file fails, and says why as Codex does", async () => {
    await put("a.txt", "one\ntwo\n");
    await put("b.txt", "alpha\nbeta\n");
    expect(
      await tryApply(
        patch("*** Update File: a.txt", "-one", "+1", "*** Add File: c.txt", "+new", "*** Update File: b.txt", "@@", " gamma", "-delta", "+DELTA"),
      ),
    ).toBe(`error: apply_patch verification failed: Failed to find expected lines in ${at("b.txt")}:\ngamma\ndelta`);
    expect(await get("a.txt")).toBe("one\ntwo\n");
    expect(await get("b.txt")).toBe("alpha\nbeta\n");
    expect(await exists("c.txt")).toBe(false);

    expect(await tryApply(patch("*** Update File: a.txt", "@@ def missing():", "-one"))).toBe(
      `error: apply_patch verification failed: Failed to find context 'def missing():' in ${at("a.txt")}`,
    );
    expect(await tryApply(patch("*** Update File: a.txt", "-one", "+1", "*** Delete File: none.txt"))).toBe(
      `error: apply_patch verification failed: Failed to read ${at("none.txt")}: File not found: none.txt`,
    );
    expect(await tryApply(patch("*** Update File: none.txt", "-x"))).toBe(
      `error: apply_patch verification failed: Failed to read file to update ${at("none.txt")}: File not found: none.txt`,
    );
    await fs.mkdir(at("sub"));
    expect(await tryApply(patch("*** Add File: sub", "+x"))).toBe(
      `error: apply_patch verification failed: Failed to write file ${at("sub")}: sub is a directory, not a file. Use bash (ls) to list it.`,
    );
    expect(await tryApply("*** Update File: a.txt\n-one")).toBe(
      "error: apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
    );
    expect(await tryApply(patch())).toBe("error: No files were modified.");
    expect(await get("a.txt")).toBe("one\ntwo\n");
  });

  it("refuses a patch that names a file twice, as Codex does", async () => {
    await put("twice.txt", "1\n2\n");
    expect(await tryApply(patch("*** Update File: twice.txt", "-1", "+one", "*** Update File: twice.txt", "-2", "+two"))).toBe(
      `error: apply_patch verification failed: invalid patch: multiple operations target ${at("twice.txt")}`,
    );
    expect(await get("twice.txt")).toBe("1\n2\n");
  });

  it("refuses a patch that would change one file twice however it names it: a Move's destination, or a symlink", async () => {
    await put("a.txt", "a\n");
    await put("b.txt", "b\n");
    expect(await tryApply(patch("*** Add File: c.txt", "+new", "*** Update File: a.txt", "*** Move to: c.txt", "-a", "+A"))).toBe(
      `error: apply_patch verification failed: invalid patch: multiple operations target ${at("c.txt")}`,
    );
    expect(await tryApply(patch("*** Update File: a.txt", "*** Move to: c.txt", "-a", "+A", "*** Update File: b.txt", "*** Move to: c.txt", "-b", "+B"))).toBe(
      `error: apply_patch verification failed: invalid patch: multiple operations target ${at("c.txt")}`,
    );
    await fs.symlink(at("a.txt"), at("link.txt"));
    expect(await tryApply(patch("*** Update File: link.txt", "-a", "+A", "*** Update File: a.txt", "-a", "+B"))).toBe(
      `error: apply_patch verification failed: invalid patch: multiple operations target ${at("a.txt")}`,
    );
    expect([await get("a.txt"), await get("b.txt"), await exists("c.txt")]).toEqual(["a\n", "b\n", false]);
  });

  it.skipIf(asRoot)("checks that a file to create can be, before changing any", async () => {
    await put("a.txt", "x\n");
    await fs.mkdir(at("locked"));
    await fs.chmod(at("locked"), 0o555);
    await put("plain", "not a directory\n");
    try {
      expect(await tryApply(patch("*** Update File: a.txt", "-x", "+X", "*** Add File: locked/new.txt", "+n"))).toBe(
        `error: apply_patch verification failed: Failed to write file ${at("locked/new.txt")}: Permission denied: locked/new.txt`,
      );
      expect(await tryApply(patch("*** Update File: a.txt", "-x", "+X", "*** Add File: plain/sub/new.txt", "+n"))).toBe(
        `error: apply_patch verification failed: Failed to write file ${at("plain/sub/new.txt")}: A parent of plain/sub/new.txt is not a directory`,
      );
      expect(await tryApply(patch("*** Update File: a.txt", "*** Move to: locked/a.txt", "-x", "+X"))).toBe(
        `error: apply_patch verification failed: Failed to write file ${at("locked/a.txt")}: Permission denied: locked/a.txt`,
      );
      expect(await get("a.txt")).toBe("x\n");
    } finally {
      await fs.chmod(at("locked"), 0o755);
    }
  });

  it("matches as Codex does: exactly, then ignoring trailing, then leading whitespace, then Unicode punctuation, keeping context lines", async () => {
    await put("ws.txt", "a = 1  \nb = 2\t\nc = 3\n");
    expect(textOf(await apply(patch("*** Update File: ws.txt", " a = 1", "-b = 2", "+b = 20", " c = 3")))).toBe(
      "Success. Updated the following files:\nM ws.txt",
    );
    expect(await get("ws.txt")).toBe("a = 1  \nb = 20\nc = 3\n");
    // Matched ignoring its indentation, the added line is written as given.
    await put("indent.py", "def f():\n    x = 1\n");
    await apply(patch("*** Update File: indent.py", " def f():", "-x = 1", "+x = 2"));
    expect(await get("indent.py")).toBe("def f():\nx = 2\n");
    await put("quotes.py", "print(“hi”)\nx = 1 — 2\nend\n");
    await apply(patch("*** Update File: quotes.py", ' print("hi")', "-x = 1 - 2", "+x = 1 + 2", " end"));
    expect(await get("quotes.py")).toBe("print(“hi”)\nx = 1 + 2\nend\n");
  });

  it("takes the first match after the last chunk, and after an @@ line", async () => {
    await put("dup.py", "def a():\n    x = 1\n    return x\n\ndef b():\n    x = 1\n    return x\n");
    await apply(patch("*** Update File: dup.py", "-    x = 1", "+    x = 2", "     return x"));
    expect(await get("dup.py")).toBe("def a():\n    x = 2\n    return x\n\ndef b():\n    x = 1\n    return x\n");
    await apply(patch("*** Update File: dup.py", "@@ def b():", "-    x = 1", "+    x = 3", "     return x"));
    expect(await get("dup.py")).toBe("def a():\n    x = 2\n    return x\n\ndef b():\n    x = 3\n    return x\n");
  });

  it("applies chunks in order, one marked at the end there, and lines only added at the file's end", async () => {
    await put("f.txt", "x\na\nx\nb\nx\n");
    await apply(patch("*** Update File: f.txt", "@@", " a", "-x", "+X", "@@", "-x", "+Y", "*** End of File"));
    expect(await get("f.txt")).toBe("x\na\nX\nb\nY\n");
    await apply(patch("*** Update File: f.txt", "@@ b", "+after b"));
    expect(await get("f.txt")).toBe("x\na\nX\nb\nY\nafter b\n");
  });

  it("keeps a file's BOM, CRLF line endings, and mode, ends its last line, and a moved file keeps its mode", async () => {
    await put("win.txt", "\uFEFFfirst\r\nsecond\r\nthird\r\n");
    await apply(patch("*** Update File: win.txt", " first", "-second", "+2nd", "+2.5"));
    expect(await get("win.txt")).toBe("\uFEFFfirst\r\n2nd\r\n2.5\r\nthird\r\n");
    await put("open.txt", "a\nb");
    await apply(patch("*** Update File: open.txt", " a", "-b", "+c"));
    expect(await get("open.txt")).toBe("a\nc\n");
    await put("run.sh", "echo old\n");
    await fs.chmod(at("run.sh"), 0o755);
    await apply(patch("*** Update File: run.sh", "*** Move to: bin/run.sh", "-echo old", "+echo new"));
    expect(await get("bin/run.sh")).toBe("echo new\n");
    expect((await fs.stat(at("bin/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await exists("run.sh")).toBe(false);
  });

  it("replaces a file an Add names, as Codex does, and shows what it replaced", async () => {
    await put("a.txt", "old\n");
    const result = await apply(patch("*** Add File: a.txt", "+new"));
    expect(await get("a.txt")).toBe("new\n");
    expect((result.details as PatchDetails).files[0]!.patch).toBe("--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n");
  });

  it("takes a heredoc, absolute paths, and paths as read resolves them", async () => {
    await put("a.txt", "x\n");
    await apply(["<<'EOF'", "*** Begin Patch", `*** Update File: ${at("a.txt")}`, "-x", "+y", "*** Add File: @b.txt", "+b", "*** End Patch", "EOF"].join("\n"));
    expect(await get("a.txt")).toBe("y\n");
    expect(await get("b.txt")).toBe("b\n");
  });

  it.skipIf(asRoot)("checks that every file can change before changing any", async () => {
    await put("a.txt", "x\n");
    await put("ro.txt", "y\n");
    await fs.chmod(at("ro.txt"), 0o444);
    expect(await tryApply(patch("*** Update File: a.txt", "-x", "+X", "*** Update File: ro.txt", "-y", "+Y"))).toBe(
      `error: apply_patch verification failed: Failed to read file to update ${at("ro.txt")}: Permission denied: ro.txt`,
    );
    expect(await get("a.txt")).toBe("x\n");
  });

  it("runs patches over the same files one at a time, whatever order they name them in", async () => {
    await put("a.txt", "0\n");
    await put("b.txt", "0\n");
    const bump = (first: string, second: string) =>
      apply(patch(`*** Update File: ${first}`, "@@", "+line", "*** End of File", `*** Update File: ${second}`, "@@", "+line", "*** End of File"));
    await Promise.all([bump("a.txt", "b.txt"), bump("b.txt", "a.txt"), bump("a.txt", "b.txt")]);
    expect(await get("a.txt")).toBe("0\nline\nline\nline\n");
    expect(await get("b.txt")).toBe("0\nline\nline\nline\n");
  });
});
