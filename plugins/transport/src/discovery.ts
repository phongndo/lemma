import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { writeFileAtomic } from "@lemma/contracts/fs";

/** `<home>/transport.json`: how local clients find a running host. */
export const Discovery = Schema.Struct({
  /** Base URL, e.g. `http://127.0.0.1:7433`; the WebSocket endpoint is `<url>/rpc` with `ws:`. */
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Number,
  /** Epoch milliseconds. */
  startedAt: Schema.Number,
});
export type Discovery = typeof Discovery.Type;

export const discoveryPath = (home: string): string => join(home, "transport.json");

const decode = Schema.decodeUnknownEither(Schema.parseJson(Discovery));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The running host's entry, or undefined when absent, unreadable, or left behind by a process that is gone. */
export const readDiscovery = (home: string): Effect.Effect<Discovery | undefined> =>
  Effect.promise(() => readFile(discoveryPath(home), "utf8").catch(() => undefined)).pipe(
    Effect.map((text) => {
      if (text === undefined) return undefined;
      const entry = Either.getOrUndefined(decode(text));
      return entry !== undefined && alive(entry.pid) ? entry : undefined;
    }),
  );

/** Written atomically with mode 0600; removed on scope close unless another host has replaced it since. */
export const publishDiscovery = (home: string, entry: Discovery) => {
  const path = discoveryPath(home);
  const write = Effect.promise(() => writeFileAtomic(path, `${JSON.stringify(entry, null, 2)}\n`));
  const removeIfOurs = Effect.promise(async () => {
    const current = Either.getOrUndefined(decode(await readFile(path, "utf8").catch(() => "")));
    if (current?.pid === entry.pid && current.startedAt === entry.startedAt && current.url === entry.url) await rm(path, { force: true });
  });
  return Effect.acquireRelease(write, () => removeIfOurs);
};
