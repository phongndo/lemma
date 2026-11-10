import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { nodeFileSystem } from "@lemma/contracts/fs";
import { readJournals, readLive, removeState, writeJournal, writeLive } from "../../src/kit/state.ts";

test("state files keep a session id in one filename and recover its original id", async () => {
  const home = await mkdtemp(join(tmpdir(), "lemma-agent-state-"));
  const files = { home, fs: nodeFileSystem };
  const ids = ["plain-id", "plain-id.live", "../outside", "nested/id", "windows\\id", "percent%2Fid"];
  const journal = { queue: [], held: true };
  const live = { turnId: "t", output: [] };
  try {
    for (const id of ids) {
      await Effect.runPromise(writeJournal(files, id, journal));
      await Effect.runPromise(writeLive(files, id, live));
      expect(await Effect.runPromise(readLive(files, id))).toEqual(live);
    }
    expect(await readdir(home)).toEqual(["agent"]);
    const found = await Effect.runPromise(readJournals(files));
    expect([...found.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(found.get(id)).toEqual(journal);
      await Effect.runPromise(removeState(files, id));
    }
    expect(await readdir(join(home, "agent"))).toEqual(["escaped"]);
    expect(await readdir(join(home, "agent", "escaped"))).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps legacy custom ids literal and removes their old files after migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "lemma-agent-state-"));
  const files = { home, fs: nodeFileSystem };
  const ids = ["old.percent%2Fid", "old.dot.id", "old%broken"];
  const journal = { queue: [], held: true };
  const live = { turnId: "t", output: [] };
  try {
    await mkdir(join(home, "agent"));
    for (const id of ids) {
      await writeFile(join(home, "agent", `${id}.json`), JSON.stringify(journal));
      await writeFile(join(home, "agent", `${id}.live.json`), JSON.stringify(live));
    }
    expect([...(await Effect.runPromise(readJournals(files))).keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(await Effect.runPromise(readLive(files, id))).toEqual(live);
      await Effect.runPromise(writeJournal(files, id, journal));
    }
    expect([...(await Effect.runPromise(readJournals(files))).keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) await Effect.runPromise(removeState(files, id));
    expect((await readdir(join(home, "agent"))).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect((await Effect.runPromise(readJournals(files))).size).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
