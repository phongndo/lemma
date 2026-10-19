import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundOutput, outputFile, realPath, replaceFile } from "../src/files.ts";
import { tempDir } from "../src/testing.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.chmod(dir, 0o700);
  await fs.rm(dir, { recursive: true, force: true });
});

const at = (name: string) => path.join(dir, name);
const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777;
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
const asRoot = process.getuid?.() === 0;

describe("replaceFile", () => {
  it("creates parent directories, and a new file with the umask's mode", async () => {
    await replaceFile(at("a/b/new.txt"), "hello");
    expect(await fs.readFile(at("a/b/new.txt"), "utf8")).toBe("hello");
    expect(await modeOf(at("a/b/new.txt"))).toBe(0o666 & ~process.umask());
  });

  it("keeps an existing file's mode, and gives a new one the mode asked for, with its content", async () => {
    await fs.writeFile(at("run.sh"), "old");
    await fs.chmod(at("run.sh"), 0o750);
    await replaceFile(at("run.sh"), "new", { mode: 0o700 });
    expect(await fs.readFile(at("run.sh"), "utf8")).toBe("new");
    expect(await modeOf(at("run.sh"))).toBe(0o750);
    await replaceFile(at("bin/moved.sh"), "moved", { mode: 0o751 });
    expect(await modeOf(at("bin/moved.sh"))).toBe(0o751);
  });

  it("writes a symlink's target and leaves the link in place, through a chain and to a missing target", async () => {
    await fs.mkdir(at("real"));
    await fs.writeFile(at("real/file.txt"), "old");
    await fs.symlink("real/file.txt", at("first"));
    await fs.symlink("first", at("second"));
    await replaceFile(at("second"), "new");
    expect((await fs.lstat(at("second"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(at("first"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(at("real/file.txt"), "utf8")).toBe("new");

    await fs.symlink("real/later.txt", at("dangling"));
    await replaceFile(at("dangling"), "made");
    expect((await fs.lstat(at("dangling"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(at("real/later.txt"), "utf8")).toBe("made");
  });

  it("refuses a directory and a symlink loop", async () => {
    await fs.mkdir(at("sub"));
    await expect(replaceFile(at("sub"), "x")).rejects.toMatchObject({ code: "EISDIR" });
    await fs.symlink("loop-b", at("loop-a"));
    await fs.symlink("loop-a", at("loop-b"));
    await expect(replaceFile(at("loop-a"), "x")).rejects.toMatchObject({ code: "ELOOP" });
  });

  it.skipIf(asRoot)("writes a file in place when its directory takes no new name", async () => {
    await fs.mkdir(at("locked"));
    await fs.writeFile(at("locked/file.txt"), "original");
    // The file stays writable, but its directory takes no new name: no temporary file can be made beside it.
    await fs.chmod(at("locked"), 0o500);
    try {
      await replaceFile(at("locked/file.txt"), "replacement");
      expect(await fs.readFile(at("locked/file.txt"), "utf8")).toBe("replacement");
      expect(await fs.readdir(at("locked"))).toEqual(["file.txt"]);
    } finally {
      await fs.chmod(at("locked"), 0o700);
    }
  });

  it.skipIf(asRoot)("still fails to make a new file in a directory that takes no new name", async () => {
    await fs.mkdir(at("locked"));
    await fs.chmod(at("locked"), 0o500);
    try {
      await expect(replaceFile(at("locked/new.txt"), "x")).rejects.toMatchObject({ code: "EACCES" });
      expect(await fs.readdir(at("locked"))).toEqual([]);
    } finally {
      await fs.chmod(at("locked"), 0o700);
    }
  });
});

describe("outputFile", () => {
  // First in the file: the sweep runs when the process makes its first output file.
  it("removes the directory a process that is gone left a day ago, and keeps a recent one", async () => {
    const gone = spawnSync("true").pid;
    const left = await fs.mkdtemp(path.join(tmpdir(), `lemma-output-${gone}-`));
    await fs.writeFile(path.join(left, "lemma-bash-0.log"), "stale");
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(left, dayAgo, dayAgo);
    // A process in another pid namespace sharing the temp directory looks gone too: its directory stays while it is in use.
    const recent = await fs.mkdtemp(path.join(tmpdir(), `lemma-output-${gone}-`));
    try {
      outputFile("lemma-test", "txt").release();
      expect(await exists(left)).toBe(false);
      expect(await exists(recent)).toBe(true);
    } finally {
      await fs.rm(recent, { recursive: true, force: true });
    }
  });

  it("makes an empty file only this user can read, in a directory only this user can open", async () => {
    const file = outputFile("lemma-test", "log").path;
    expect(path.basename(file)).toMatch(/^lemma-test-[0-9a-f]{16}\.log$/);
    expect(await fs.readFile(file, "utf8")).toBe("");
    expect(await modeOf(file)).toBe(0o600);
    expect(await modeOf(path.dirname(file))).toBe(0o700);
    expect(path.basename(path.dirname(file))).toMatch(new RegExp(`^lemma-output-${process.pid}-`));
  });

  it("keeps the newest 100 written files, and every file still being written", async () => {
    const writing = outputFile("lemma-test", "log");
    const files = Array.from({ length: 101 }, () => outputFile("lemma-test", "txt"));
    for (const file of files) file.release();
    expect(await exists(writing.path)).toBe(true);
    expect(await exists(files[0]!.path)).toBe(false);
    expect(await exists(files[1]!.path)).toBe(true);
    expect(await exists(files[100]!.path)).toBe(true);
    writing.release();
    expect(await exists(writing.path)).toBe(false);
  });

  it("makes its directory again when something removed it", async () => {
    const first = outputFile("lemma-test", "txt");
    first.release();
    await fs.rm(path.dirname(first.path), { recursive: true, force: true });
    const next = outputFile("lemma-test", "txt");
    expect(await fs.readFile(next.path, "utf8")).toBe("");
    expect(await modeOf(path.dirname(next.path))).toBe(0o700);
    next.release();
  });
});

describe("boundOutput", () => {
  it("saves the whole text to a private output file", async () => {
    const long = "x".repeat(5_000);
    const { content, fullOutputPath } = await boundOutput([{ type: "text", text: long }], { budget: 100, name: "test" });
    expect(fullOutputPath).toBeDefined();
    expect(await fs.readFile(fullOutputPath!, "utf8")).toBe(long);
    expect(await modeOf(fullOutputPath!)).toBe(0o600);
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`[Full output: ${fullOutputPath} (read with offset/limit)]`) });
  });
});

describe("realPath", () => {
  it("names a file one way, through symlinks to it or to a directory it is in, whether or not it exists yet", async () => {
    await fs.mkdir(at("real"));
    await fs.writeFile(at("real/file.txt"), "x");
    await fs.symlink(at("real"), at("dir-link"));
    await fs.symlink(at("real/file.txt"), at("file-link"));
    const real = await realPath(at("real/file.txt"));
    expect(await realPath(at("file-link"))).toBe(real);
    expect(await realPath(at("dir-link/file.txt"))).toBe(real);
    expect(await realPath(at("dir-link/new/later.txt"))).toBe(path.join(await realPath(at("real")), "new", "later.txt"));
  });
});
