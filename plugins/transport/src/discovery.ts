import { rm } from "node:fs/promises";
import { Effect } from "effect";
import { Discovery, discoveryPath } from "@lemma/contracts/discovery";
import { readJsonFile, writeFileAtomic } from "@lemma/contracts/fs";

/** Written atomically with mode 0600; removed on scope close unless another host has replaced it since. */
export const publishDiscovery = (home: string, entry: Discovery) => {
  const path = discoveryPath(home);
  const write = Effect.promise(() => writeFileAtomic(path, `${JSON.stringify(entry, null, 2)}\n`));
  const removeIfOurs = Effect.promise(async () => {
    const current = await readJsonFile(path, Discovery);
    if (current?.pid === entry.pid && current.startedAt === entry.startedAt && current.url === entry.url) await rm(path, { force: true });
  });
  return Effect.acquireRelease(write, () => removeIfOurs);
};
