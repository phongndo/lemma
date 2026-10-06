import { constants } from "node:fs";
import { describe, expect, test } from "vitest";
import { writeFileAtomic } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { seededRandom, SimDisk } from "../src/index.ts";

const syncDir = async (fs: FileSystem, dir: string) => {
  const handle = await fs.open(dir, "r");
  await handle.sync();
  await handle.close();
};

const withFile = async (disk: SimDisk, file: string, synced: string, unsynced: string) => {
  const fs = disk.mount();
  await fs.mkdir("/data", { recursive: true });
  await syncDir(fs, "/");
  const handle = await fs.open(file, "ax");
  await handle.appendFile(synced);
  await handle.datasync();
  await syncDir(fs, "/data");
  await handle.appendFile(unsynced);
  return { fs, handle };
};

describe("SimDisk", () => {
  test("synced bytes survive a crash; unsynced appended bytes survive as some prefix, maybe torn, maybe followed by zeros", async () => {
    const outcomes = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const disk = new SimDisk(seededRandom(seed));
      await withFile(disk, "/data/log", "one\n", "two\nthree\n");
      disk.crash();
      const text = disk.read("/data/log")!;
      expect(text.startsWith("one\n")).toBe(true);
      const rest = text.slice(4).replace(/\0+$/, "");
      expect("two\nthree\n".startsWith(rest)).toBe(true);
      outcomes.add(rest === "" ? "none" : rest === "two\nthree\n" ? "all" : rest.endsWith("\n") ? "lines" : "torn");
      if (text.includes("\0")) outcomes.add("zeros");
    }
    expect([...outcomes].sort()).toEqual(["all", "lines", "none", "torn", "zeros"]);
  });

  test("a name is durable once its directory is synced, and a directory's own name once its parent is", async () => {
    const kept = { file: new Set<boolean>(), dir: new Set<boolean>() };
    for (let seed = 0; seed < 50; seed++) {
      const disk = new SimDisk(seededRandom(seed));
      const fs = disk.mount();
      await fs.mkdir("/d", { recursive: true });
      await syncDir(fs, "/");
      const synced = await fs.open("/d/synced", "wx");
      await synced.datasync();
      await syncDir(fs, "/d");
      const unsynced = await fs.open("/d/unsynced", "wx");
      await unsynced.datasync();
      await fs.mkdir("/e", { recursive: true });
      const inUnsyncedDir = await fs.open("/e/f", "wx");
      await inUnsyncedDir.datasync();
      await syncDir(fs, "/e");
      disk.crash();
      expect(disk.read("/d/synced")).toBe("");
      kept.file.add(disk.read("/d/unsynced") !== undefined);
      kept.dir.add(disk.read("/e/f") !== undefined);
    }
    expect([...kept.file].sort()).toEqual([false, true]);
    expect([...kept.dir].sort()).toEqual([false, true]);
  });

  test("a name survives a crash only if every directory above it does", async () => {
    for (let seed = 0; seed < 50; seed++) {
      const disk = new SimDisk(seededRandom(seed));
      const fs = disk.mount();
      await fs.mkdir("/a/b/c", { recursive: true });
      // Only the deepest directory is synced: its file's name is durable, the directories above are not.
      const file = await fs.open("/a/b/c/log", "wx");
      await file.datasync();
      await syncDir(fs, "/a/b/c");
      disk.crash();
      const fresh = disk.mount();
      const reachable = await fresh.stat("/a/b/c").then(
        () => true,
        () => false,
      );
      expect(disk.read("/a/b/c/log") !== undefined, `seed ${seed}`).toBe(reachable);
    }
  });

  test("a crash ends the process: its mounts and handles fail", async () => {
    const disk = new SimDisk(seededRandom(1));
    const { fs, handle } = await withFile(disk, "/data/log", "a\n", "");
    disk.crash();
    await expect(handle.appendFile("b\n")).rejects.toMatchObject({ code: "EIO" });
    await expect(fs.stat("/data/log")).rejects.toMatchObject({ code: "EIO" });
    expect(await disk.mount().readFile("/data/log", "utf8")).toBe("a\n");
  });

  test("open follows the POSIX flags storage code uses", async () => {
    const fs = new SimDisk(seededRandom(2)).mount();
    await expect(fs.open("/missing/file", "ax")).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir("/d", { recursive: true });
    const created = await fs.open("/d/f", "ax");
    await created.appendFile("x");
    await expect(fs.open("/d/f", "wx")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.open("/d/g", constants.O_WRONLY | constants.O_APPEND)).rejects.toMatchObject({ code: "ENOENT" });
    const appending = await fs.open("/d/f", constants.O_WRONLY | constants.O_APPEND);
    await appending.appendFile("y");
    expect(await fs.readFile("/d/f", "utf8")).toBe("xy");
    await expect(fs.readdir("/d/f")).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await fs.readdir("/d")).toEqual(["f"]);
    const buffer = new Uint8Array(8);
    const reader = await fs.open("/d/f", "r");
    expect((await reader.read(buffer, 0, 8, 1)).bytesRead).toBe(1);
    expect(new TextDecoder().decode(buffer.subarray(0, 1))).toBe("y");
  });

  test("injected faults: a failed write may leave part of its bytes, a failed sync makes nothing durable", async () => {
    const disk = new SimDisk(seededRandom(3));
    const { handle } = await withFile(disk, "/data/log", "synced\n", "");
    disk.faults.write = 1;
    await expect(handle.appendFile("0123456789\n")).rejects.toMatchObject({ code: "ENOSPC" });
    expect("0123456789\n".startsWith(disk.read("/data/log")!.slice("synced\n".length))).toBe(true);
    disk.faults.write = 0;
    disk.faults.sync = 1;
    await expect(handle.datasync()).rejects.toMatchObject({ code: "EIO" });
    expect(disk.injected.get("write")).toBe(1);
    expect(disk.injected.get("sync")).toBe(1);
  });

  test("another program's changes: an open handle keeps the file it opened", async () => {
    const disk = new SimDisk(seededRandom(4));
    const { fs, handle } = await withFile(disk, "/data/log", "mine\n", "");
    disk.outside.replace("/data/log", "theirs\n");
    expect((await handle.stat()).nlink).toBe(0);
    expect(await fs.readFile("/data/log", "utf8")).toBe("theirs\n");
    disk.outside.append("/data/log", "more\n");
    expect((await fs.stat("/data/log")).size).toBe("theirs\nmore\n".length);
  });

  test("writeFileAtomic on the simulated disk: a crash leaves the old or the new file, never a mix", async () => {
    const seen = new Set<string | undefined>();
    for (let seed = 0; seed < 60; seed++) {
      const disk = new SimDisk(seededRandom(seed));
      const fs = disk.mount();
      await writeFileAtomic("/state/x.json", "old", { fs, sync: true });
      await syncDir(fs, "/");
      await syncDir(fs, "/state");
      await writeFileAtomic("/state/x.json", "new", { fs, sync: true });
      disk.crash();
      const text = disk.read("/state/x.json");
      expect(["old", "new"]).toContain(text);
      seen.add(text);
      expect(disk.list().filter((file) => file.endsWith(".tmp"))).toEqual([]);
    }
    expect([...seen].sort()).toEqual(["new", "old"]);
  });
});
