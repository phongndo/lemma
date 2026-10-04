import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeFileAtomic } from "../src/fs.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lemma-fs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("replaces the file whole, creating its directory, with the mode asked for", async () => {
    const path = join(dir, "nested", "file.json");
    expect(await writeFileAtomic(path, "one")).toBe(true);
    expect(await writeFileAtomic(path, "two", { sync: true, mode: 0o644 })).toBe(true);
    expect(await readFile(path, "utf8")).toBe("two");
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(dir, "nested"))).toEqual(["file.json"]);
  });

  test("exclusive: creates the file once and leaves an existing one as it is", async () => {
    const path = join(dir, "token");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => writeFileAtomic(path, `t${i}`, { exclusive: true })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readFile(path, "utf8")).toMatch(/^t\d$/);
    expect(await readdir(dir)).toEqual(["token"]);
  });

  test("leaves no temporary file when the write fails", async () => {
    // A directory where the file should go: the rename fails.
    const path = join(dir, "taken");
    await mkdir(path);
    await expect(writeFileAtomic(path, "x")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["taken"]);
  });
});
