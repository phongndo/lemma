import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Schema } from "effect";
import { expandHome, isAlive, isInside, kindOf, readJsonFile, writeFileAtomic } from "../src/fs.ts";

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

describe("paths", () => {
  test("isInside: the root and what is under it, not a sibling or its parent, whatever the names start with", () => {
    expect(isInside("/srv/app", "/srv/app")).toBe(true);
    expect(isInside("/srv/app/", "/srv/app/..env")).toBe(true);
    expect(isInside("/srv/app", "/srv/app/a/../b")).toBe(true);
    expect(isInside("/srv/app", "/srv/app/../app2")).toBe(false);
    expect(isInside("/srv/app", "/srv/app-other")).toBe(false);
    expect(isInside("/srv/app", "/srv")).toBe(false);
  });

  test("expandHome: ~ and ~/ only, normalized when absolute", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/code/x/", "/home/u")).toBe("/home/u/code/x");
    expect(expandHome("~other/x", "/home/u")).toBe("~other/x");
    expect(expandHome("/a/../b", "/home/u")).toBe("/b");
    expect(expandHome("relative", "/home/u")).toBe("relative");
  });

  test("kindOf: a file, a directory, or nothing", async () => {
    await writeFile(join(dir, "file"), "");
    expect(await kindOf(join(dir, "file"))).toBe("file");
    expect(await kindOf(dir)).toBe("directory");
    expect(await kindOf(join(dir, "missing"))).toBeUndefined();
  });

  test("isAlive: this process, and not a pid nothing has", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 1)).toBe(false);
  });
});

describe("readJsonFile", () => {
  test("decodes the file, and is undefined when it is missing, not JSON, or not the schema", async () => {
    const Entry = Schema.Struct({ pid: Schema.Number });
    await writeFile(join(dir, "good.json"), `{"pid": 7}`);
    await writeFile(join(dir, "torn.json"), `{"pid": 7`);
    await writeFile(join(dir, "other.json"), `{"pid": "7"}`);
    expect(await readJsonFile(join(dir, "good.json"), Entry)).toEqual({ pid: 7 });
    expect(await readJsonFile(join(dir, "missing.json"), Entry)).toBeUndefined();
    expect(await readJsonFile(join(dir, "torn.json"), Entry)).toBeUndefined();
    expect(await readJsonFile(join(dir, "other.json"), Entry)).toBeUndefined();
  });
});
