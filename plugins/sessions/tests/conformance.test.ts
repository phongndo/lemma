import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";
import { pathsPlugin } from "@lemma/contracts/testing";
import { seededRandom, sessionsConformance, SimDisk } from "@lemma/testing";
import sessions, { makeSessionsPlugin } from "../src/index.ts";

const paths = (root: string) => pathsPlugin(root, { cwd: "/work" });

sessionsConformance("the plugin on a simulated disk", () => [paths("/home"), makeSessionsPlugin({ fs: new SimDisk(seededRandom(1)).mount() })]);

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));
sessionsConformance("the plugin on the real file system", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-"));
  dirs.push(dir);
  return [paths(dir), sessions];
});
