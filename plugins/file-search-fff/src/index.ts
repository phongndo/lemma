import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { FileSearchError, FileSearchers, Inspectors } from "@lemma/contracts";
import type { FileEntry, FileKind, FileSearcher, FileSearchOptions, FileSearchResult } from "@lemma/contracts";
import { expandHome, kindOf } from "@lemma/contracts/fs";

/** Entries a search returns when the caller does not say. */
export const DEFAULT_LIMIT = 50;
/** How long a search waits for a directory's first scan before answering with what is indexed so far (`indexing`). */
export const SCAN_WAIT_MS = 2_000;
/** Where the bundled searcher sits in `FileSearchers`: a plugin contributing below it answers instead. */
export const SEARCHER_ORDER = 100;
/** The longest delay a timer takes; beyond it Node fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
interface Page<Item> {
  readonly items: readonly Item[];
  readonly totalMatched: number;
}

/** The part of fff's `FileFinder` this plugin uses: a test, or another engine of the same shape, stands in for it. */
export interface Finder {
  readonly fileSearch: (query: string, options: { readonly pageSize: number }) => Result<Page<{ readonly relativePath: string }>>;
  readonly directorySearch: (query: string, options: { readonly pageSize: number }) => Result<Page<{ readonly relativePath: string }>>;
  readonly mixedSearch: (
    query: string,
    options: { readonly pageSize: number },
  ) => Result<Page<{ readonly type: "file" | "directory"; readonly item: { readonly relativePath: string } }>>;
  readonly isScanning: () => boolean;
  readonly waitForScan: (timeoutMs: number) => Promise<Result<boolean>>;
  readonly getScanProgress: () => Result<{ readonly scannedFilesCount: number }>;
  readonly destroy: () => void;
}

/** Opens an index of `root` (an existing directory, symlinks resolved); rejects when it cannot. */
export type OpenFinder = (root: string) => Promise<Finder>;

/**
 * fff, loaded on first use: a platform without its native library fails
 * searches (`Unavailable`), not the plugin. Paths only, no content index, and
 * fff's own watcher keeps the index current as files change.
 */
export const openFff: OpenFinder = async (root) => {
  const { FileFinder } = await import("@ff-labs/fff-node");
  const created = FileFinder.create({ basePath: root, disableContentIndexing: true, disableMmapCache: true });
  if (!created.ok) throw new Error(created.error);
  return created.value;
};

export interface FileSearchInit {
  readonly open?: OpenFinder;
  /** An index nobody has searched for this long is closed. */
  readonly idleMs: number;
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

const run = (finder: Finder, query: string, pageSize: number, kind: FileKind | undefined): Result<Page<FileEntry>> => {
  const mapped = <Item>(result: Result<Page<Item>>, map: (item: Item) => FileEntry): Result<Page<FileEntry>> =>
    result.ok ? { ok: true, value: { items: result.value.items.map(map), totalMatched: result.value.totalMatched } } : result;
  if (kind === "file") return mapped(finder.fileSearch(query, { pageSize }), (item) => entry(item.relativePath, "file"));
  if (kind === "directory") return mapped(finder.directorySearch(query, { pageSize }), (item) => entry(item.relativePath, "directory"));
  return mapped(finder.mixedSearch(query, { pageSize }), (item) => entry(item.item.relativePath, item.type));
};

interface Index {
  readonly finder: Promise<Finder>;
  /** Searches using it now: it is not closed while any is. */
  users: number;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One index per work tree (or per directory outside one), opened by its first
 * search and closed `idleMs` after the last search using it ends, or when the
 * scope closes. Searches that arrive while it opens share it. A search in a
 * subdirectory uses its repository's index, so the root's ignore files apply.
 */
export const makeFileSearch = (init: FileSearchInit) =>
  Effect.gen(function* () {
    const open = init.open ?? openFff;
    const home = homedir();
    const realHome = yield* Effect.promise(() => realpath(home).catch(() => home));
    const idleMs = Math.min(init.idleMs, MAX_TIMEOUT_MS);
    const indexes = new Map<string, Index>();

    const close = (root: string) => {
      const index = indexes.get(root);
      if (index === undefined) return;
      indexes.delete(root);
      clearTimeout(index.timer);
      void index.finder.then(
        (finder) => finder.destroy(),
        () => undefined,
      );
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => [...indexes.keys()].forEach(close)));

    const acquire = (root: string): Index => {
      let index = indexes.get(root);
      if (index === undefined) {
        const opened: Index = { finder: open(root), users: 0, lastUsed: Date.now() };
        index = opened;
        indexes.set(root, opened);
        // A failed open is not kept: the next search tries again.
        opened.finder.catch(() => indexes.get(root) === opened && close(root));
      }
      clearTimeout(index.timer);
      index.users++;
      return index;
    };
    const release = (root: string, index: Index) => {
      index.users--;
      index.lastUsed = Date.now();
      if (index.users > 0 || indexes.get(root) !== index) return;
      index.timer = setTimeout(() => close(root), idleMs);
      index.timer.unref?.();
    };

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
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => acquire(root)),
          (index) =>
            Effect.gen(function* () {
              const finder = yield* Effect.tryPromise({
                try: () => index.finder,
                catch: (cause) => new FileSearchError({ path, reason: "Unavailable", message: `File search is unavailable here: ${message(cause)}`, cause }),
              });
              if (finder.isScanning()) yield* Effect.promise(() => finder.waitForScan(SCAN_WAIT_MS));
              const limit = options.limit ?? DEFAULT_LIMIT;
              const scoped = scope === "" ? query.trim() : `${insideGlob(scope)} ${query.trim()}`.trim();
              // One more than asked, and room for what is dropped: the scope folder itself, and `?` matches outside it.
              const result = run(finder, scoped, limit + 2, options.kind);
              if (!result.ok) return yield* new FileSearchError({ path, reason: "Failed", message: result.error });
              const inside = result.value.items.filter((item) => (scope === "" ? item.path !== "" : item.path.startsWith(`${scope}/`)));
              const dropped = result.value.items.length - inside.length;
              return {
                root: path,
                entries: inside.slice(0, limit).map((item) => (base === "" ? item : { ...item, path: item.path.slice(base.length + 1) })),
                truncated: result.value.totalMatched - dropped > limit,
                ...(finder.isScanning() ? { indexing: true } : {}),
              };
            }),
          (index) => Effect.sync(() => release(root, index)),
        );
      });

    /** The open indexes, for the inspector. */
    const snapshot = Effect.promise(() =>
      Promise.all(
        [...indexes].map(async ([root, index]) => {
          const finder = await index.finder.catch(() => undefined);
          const progress = finder?.getScanProgress();
          return {
            root,
            files: progress?.ok === true ? progress.value.scannedFilesCount : 0,
            scanning: finder?.isScanning() ?? false,
            searching: index.users,
            idleSeconds: index.users > 0 ? 0 : Math.round((Date.now() - index.lastUsed) / 1000),
          };
        }),
      ),
    );

    return { service: { search } satisfies Omit<FileSearcher, "id">, snapshot };
  });

export const FileSearchConfig = Schema.Struct({
  idleMinutes: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 24 * 60 }))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 15)))
    .annotate({
      title: "Keep an index for",
      description: "Minutes (1 to 1440) a repository's index stays in memory after its last search; the next search opens it again.",
    }),
});

/** Contributes the bundled `FileSearchers` entry: nothing requires it, so turning it off leaves the host running. */
export default definePlugin({
  id: "file-search",
  version: "0.1.0",
  config: FileSearchConfig,
  layer: (config) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const { service, snapshot } = yield* makeFileSearch({ idleMs: config.idleMinutes * 60_000 });
        yield* owner.add(FileSearchers, { id: owner.id, ...service }, { order: SEARCHER_ORDER }).pipe(Effect.orDie);
        yield* owner
          .add(Inspectors, {
            id: "file-search.indexes",
            title: "File search indexes",
            description: "Open indexes: files read, whether a scan is running, searches using it, and seconds since the last one ended",
            snapshot,
          })
          .pipe(Effect.ignore);
      }),
    ),
});
