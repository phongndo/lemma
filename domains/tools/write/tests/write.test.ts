import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTool } from "../src/index.ts";
import { attempt, call, context, tempDir, textOf } from "@lemma/tools/testing";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const get = (name: string) => fs.readFile(path.join(dir, name), "utf8");

describe("write", () => {
  it("creates parent directories and overwrites", async () => {
    const result = await call(writeTool, { path: "deep/er/file.txt", content: "héllo" }, context(dir));
    expect(textOf(result)).toBe("Successfully wrote 6 bytes to deep/er/file.txt");
    await call(writeTool, { path: "deep/er/file.txt", content: "bye" }, context(dir));
    expect(await get("deep/er/file.txt")).toBe("bye");
  });

  it("keeps the file's mode, and writes a symlink's target, leaving the link", async () => {
    await fs.writeFile(path.join(dir, "run.sh"), "old");
    await fs.chmod(path.join(dir, "run.sh"), 0o755);
    await fs.symlink("run.sh", path.join(dir, "link.sh"));
    await call(writeTool, { path: "link.sh", content: "new" }, context(dir));
    expect(await get("run.sh")).toBe("new");
    expect((await fs.lstat(path.join(dir, "link.sh"))).isSymbolicLink()).toBe(true);
    expect((await fs.stat(path.join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("reports a directory and a parent that is a file, writing nothing", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "plain"), "x");
    expect(await attempt(writeTool, { path: "sub", content: "x" }, context(dir))).toBe(
      "error: Could not write sub: sub is a directory, not a file. Use bash (ls) to list it.",
    );
    expect(await attempt(writeTool, { path: "plain/f.txt", content: "x" }, context(dir))).toContain("Could not write plain/f.txt");
    expect((await fs.readdir(dir)).sort()).toEqual(["plain", "sub"]);
    expect(await fs.readdir(path.join(dir, "sub"))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("writes a file in place when its directory takes no new name", async () => {
    await fs.mkdir(path.join(dir, "locked"));
    await fs.writeFile(path.join(dir, "locked/f.txt"), "original");
    // The file is writable but its directory takes no new name, so no replacement can be made beside it.
    await fs.chmod(path.join(dir, "locked"), 0o500);
    try {
      expect(await attempt(writeTool, { path: "locked/f.txt", content: "replacement" }, context(dir))).toBe("ok: Successfully wrote 11 bytes to locked/f.txt");
      expect(await get("locked/f.txt")).toBe("replacement");
      expect(await fs.readdir(path.join(dir, "locked"))).toEqual(["f.txt"]);
    } finally {
      await fs.chmod(path.join(dir, "locked"), 0o700);
    }
  });

  it("runs concurrent writes to one file one at a time, so the file holds one of them whole", async () => {
    const contents = Array.from({ length: 8 }, (_, index) => String(index).repeat(100_000));
    await Promise.all(contents.map((content) => call(writeTool, { path: "f.txt", content }, context(dir))));
    expect(contents).toContain(await get("f.txt"));
    expect(await fs.readdir(dir)).toEqual(["f.txt"]);
  });

  it("does not write once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await attempt(writeTool, { path: "f.txt", content: "x" }, context(dir, controller.signal))).toBe("error: Operation aborted");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
