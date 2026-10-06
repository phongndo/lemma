import * as path from "node:path";
import { Effect, Schema } from "effect";
import { SessionInfo } from "@lemma/contracts";
import { readJsonFile, writeFileAtomic } from "@lemma/contracts/fs";
import type { Scanned } from "./file.ts";

/**
 * `<sessions>/.index.json`: what `list` last learned of each session file, by
 * its path under the sessions directory. A restarted host re-reads only the
 * files that changed since, and of those only the bytes appended since. It is
 * a cache: one that is missing or unreadable is rebuilt from the files.
 */
const Index = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record(
    Schema.String,
    Schema.Struct({
      size: Schema.Number,
      mtimeMs: Schema.Number,
      ino: Schema.Number,
      validBytes: Schema.Number,
      lines: Schema.Number,
      lastStart: Schema.Number,
      lastHash: Schema.String,
      info: SessionInfo,
    }),
  ),
});

const indexFile = (root: string): string => path.join(root, ".index.json");

export const readIndex = (root: string): Effect.Effect<Map<string, Scanned>> =>
  Effect.promise(async () => new Map<string, Scanned>(Object.entries((await readJsonFile(indexFile(root), Index))?.files ?? {})));

/** Replaces the index whole. Best effort: without it the next start reads the files. */
export const writeIndex = (root: string, files: ReadonlyMap<string, Scanned>): Effect.Effect<void> =>
  Effect.promise(() =>
    writeFileAtomic(indexFile(root), `${JSON.stringify({ version: 1, files: Object.fromEntries(files) })}\n`, { mode: 0o644, dirMode: 0o755 }).catch(
      () => undefined,
    ),
  );
