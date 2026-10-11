import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { pathsPlugin } from "@lemma/contracts/testing";
import { seededRandom, sessionsConformance, SimDisk } from "@lemma/testing";
import type { Deletions } from "@lemma/testing";
import { makeSessionsPlugin } from "../src/index.ts";

const paths = (root: string) => pathsPlugin(root, { cwd: "/work" });

/** `disk`, deleting a session's file only once `deletions` lets it. */
const deletingThrough = (disk: FileSystem, deletions: Deletions): FileSystem => ({
  ...disk,
  rm: (file, options) => (file.endsWith(".jsonl") ? deletions.before().then(() => disk.rm(file, options)) : disk.rm(file, options)),
});

sessionsConformance("the plugin on a simulated disk", (deletions) => [
  paths("/home"),
  makeSessionsPlugin({ fs: deletingThrough(new SimDisk(seededRandom(1)).mount(), deletions) }),
]);

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));
sessionsConformance("the plugin on the real file system", async (deletions) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-"));
  dirs.push(dir);
  return [paths(dir), makeSessionsPlugin({ fs: deletingThrough(nodeFileSystem, deletions) })];
});
