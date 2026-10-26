import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Inspectors } from "@lemma/contracts";
import { FileSearchError, FileSearchers } from "@lemma/workspace";
import type { FileEntry, FileKind, FileSearcher, FileSearchOptions, FileSearchResult } from "@lemma/workspace";
import { FffIndexes } from "@lemma/workspace/fff";
import type { FffIndex } from "@lemma/workspace/fff";
import { makeIndexes } from "./indexes.ts";
import type { Indexes } from "./indexes.ts";

import { expandHome, kindOf } from "@lemma/contracts/fs";

export { makeIndexes, openFff } from "./indexes.ts";
export type { Finder, Indexes, IndexSnapshot, OpenFinder } from "./indexes.ts";

/** Entries a search returns when the caller does not say. */
export const DEFAULT_LIMIT = 50;
/** How long a search waits for a directory's first scan before answering with what is indexed so far (`indexing`). */
export const SCAN_WAIT_MS = 2_000;

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
interface Page<Item> {
  readonly items: readonly Item[];
  readonly totalMatched: number;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const posix = (path: string) => (sep === "/" ? path : path.split(sep).join("/"));
const isDirectory = async (path: string) => (await kindOf(path)) === "directory";

/**
 * A folder as an fff glob over everything inside it (`src/lib/**`): glob
 * characters escaped, and whitespace, which would split the query into words,
 * matched by `?` (the exact prefix is checked afterwards).
 */
export const insideGlob = (folder: string): string => `${folder.replace(/[\\*?[\]{}!]/g, "\\$&").replace(/\s/g, "?")}/**`;

/** `within` as `/`-separated segments inside the directory, or undefined when it would leave it. */
const folderOf = (within: string | undefined): string | undefined => {
  if (within === undefined) return "";
  const segments = within.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  return within.startsWith("/") || segments.includes("..") ? undefined : segments.join("/");
};

/** fff reports a directory as `src/components/` and the root as an empty path; entries use `/` and no trailing slash. */
const entry = (relativePath: string, kind: FileKind): FileEntry => ({ path: posix(relativePath).replace(/\/+$/, ""), kind });

const run = (finder: FffIndex, query: string, pageSize: number, kind: FileKind | undefined): Result<Page<FileEntry>> => {
  const mapped = <Item>(result: Result<Page<Item>>, map: (item: Item) => FileEntry): Result<Page<FileEntry>> =>
    result.ok ? { ok: true, value: { items: result.value.items.map(map), totalMatched: result.value.totalMatched } } : result;
  if (kind === "file") return mapped(finder.fileSearch(query, { pageSize }), (item) => entry(item.relativePath, "file"));
  if (kind === "directory") return mapped(finder.directorySearch(query, { pageSize }), (item) => entry(item.relativePath, "directory"));
  return mapped(finder.mixedSearch(query, { pageSize }), (item) => entry(item.item.relativePath, item.type));
};

/**
 * Searches files with `indexes`: one index per work tree (or per directory outside one), so a search in a subdirectory
 * uses its repository's index, and the root's ignore files apply.
 */
export const makeFileSearch = (indexes: Pick<Indexes, "use">) =>
  Effect.gen(function* () {
    const home = homedir();
    const realHome = yield* Effect.promise(() => realpath(home).catch(() => home));

    /** The work tree `dir` is in (where `.git` is), else `dir`: never the home directory or `/`, which fff refuses. */
    const rootOf = async (dir: string): Promise<string> => {
      for (let at = dir; at !== realHome && dirname(at) !== at; at = dirname(at)) {
        if ((await kindOf(join(at, ".git"))) !== undefined) return at;
      }
      return dir;
    };

    const search = (cwd: string, query: string, options: FileSearchOptions = {}): Effect.Effect<FileSearchResult, FileSearchError> =>
      Effect.gen(function* () {
        const path = expandHome(cwd, home);
        const notFound = (where: string, why: string) => new FileSearchError({ path: where, reason: "NotFound", message: `"${where}" ${why}` });
        if (!isAbsolute(path)) return yield* notFound(path, "is not a directory");
        // Symlinks resolved: one index per directory, and fff reads git status only under a real path.
        const dir = yield* Effect.tryPromise({
          try: async () => ((await isDirectory(path)) ? realpath(path) : undefined),
          catch: () => notFound(path, "is not a directory"),
        });
        if (dir === undefined) return yield* notFound(path, "is not a directory");
        const folder = folderOf(options.within);
        if (folder === undefined || (folder !== "" && !(yield* Effect.promise(() => isDirectory(join(dir, folder)))))) {
          return yield* notFound(join(path, options.within ?? ""), `is not a folder in ${path}`);
        }
        const root = yield* Effect.promise(() => rootOf(dir));
        // Where `dir` is in the index, and where the search keeps to: entries outside `scope` are dropped.
        const base = posix(relative(root, dir));
        const scope = [base, folder].filter((part) => part !== "").join("/");
        const found = yield* Effect.tryPromise({
          try: () =>
            indexes.use(root, async (finder) => {
              if (finder.isScanning()) await finder.waitForScan(SCAN_WAIT_MS);
              const limit = options.limit ?? DEFAULT_LIMIT;
              const scoped = scope === "" ? query.trim() : `${insideGlob(scope)} ${query.trim()}`.trim();
              // One more than asked, and room for what is dropped: the scope folder itself, and `?` matches outside it.
              return { limit, result: run(finder, scoped, limit + 2, options.kind), indexing: finder.isScanning() };
            }),
          catch: (cause) => new FileSearchError({ path, reason: "Unavailable", message: message(cause), cause }),
        });
        const { limit, result, indexing } = found;
        if (!result.ok) return yield* new FileSearchError({ path, reason: "Failed", message: result.error });
        const inside = result.value.items.filter((item) => (scope === "" ? item.path !== "" : item.path.startsWith(`${scope}/`)));
        const dropped = result.value.items.length - inside.length;
        return {
          root: path,
          entries: inside.slice(0, limit).map((item) => (base === "" ? item : { ...item, path: item.path.slice(base.length + 1) })),
          truncated: result.value.totalMatched - dropped > limit,
          ...(indexing ? { indexing: true } : {}),
        };
      });

    return { search } satisfies Omit<FileSearcher, "id">;
  });

export const FileSearchConfig = Schema.Struct({
  idleMinutes: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 24 * 60 }))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 15)))
    .annotate({
      title: "Keep an index for",
      description:
        "Minutes (1 to 1440) a directory's index stays in memory after its last search, by file search or the grep and find tools; the next search opens it again.",
    }),
});

/**
 * Opens and keeps fff's indexes (`FffIndexes`), and contributes the bundled `FileSearchers` entry, searching with them:
 * nothing requires the entry, so turning the plugin off leaves the host running, without file search or the tools that
 * search with its indexes.
 */
export default definePlugin({
  id: "workspace.search-fff",
  version: "0.1.0",
  config: FileSearchConfig,
  provides: { indexes: FffIndexes },
  setup: function* (_, owner) {
    const indexes = makeIndexes({ idleMs: owner.config.idleMinutes * 60_000 });
    yield* Effect.addFinalizer(() => Effect.sync(indexes.close));
    const service = yield* makeFileSearch(indexes);
    yield* owner.add(FileSearchers, { id: owner.id, ...service }, { phase: "default" }).pipe(Effect.orDie);
    yield* owner
      .add(Inspectors, {
        id: "workspace.search-fff.indexes",
        title: "File search indexes",
        description: "Open indexes: files read, whether a scan is running, searches using it, and seconds since the last one ended",
        snapshot: Effect.promise(indexes.snapshot),
      })
      .pipe(Effect.ignore);
    return { indexes: { use: indexes.use } };
  },
});
