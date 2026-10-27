import type { FileFinderApi } from "@ff-labs/fff-node";
import type { FffIndexesService } from "@lemma/workspace/fff";

/** fff's `FileFinder`: a test, or another engine of the same shape, stands in for it. */
export type Finder = FileFinderApi;

/** Opens an index of `root`, an existing directory with symlinks resolved; rejects when it cannot. */
export type OpenFinder = (root: string) => Promise<Finder>;

/**
 * fff, loaded on first use: a platform without its native library fails the
 * searches, not the plugin. Its defaults for agents, since the `grep` tool
 * searches the same index: contents indexed and files mapped once scanned, so
 * a grep reads memory rather than the disk, and fff's watcher keeps both current.
 */
export const openFff: OpenFinder = async (root) => {
  const { FileFinder } = await import("@ff-labs/fff-node");
  const created = FileFinder.create({ basePath: root, aiMode: true });
  if (!created.ok) throw new Error(created.error);
  return created.value;
};

/** The longest delay a timer takes; beyond it Node fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface Index {
  readonly finder: Promise<Finder>;
  /** Calls using it now: it is not closed while any is. */
  users: number;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface IndexSnapshot {
  readonly root: string;
  readonly files: number;
  readonly scanning: boolean;
  readonly searching: number;
  readonly idleSeconds: number;
}

export interface Indexes extends FffIndexesService {
  /** Runs `body` with the index of `root`, opening it on first use; it is closed `idleMs` after the last call using it ends. */
  readonly use: <A>(root: string, body: (finder: Finder) => Promise<A>) => Promise<A>;
  /** The open indexes, for the inspector. */
  readonly snapshot: () => Promise<readonly IndexSnapshot[]>;
  /** Closes every index. */
  readonly close: () => void;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * One index per directory searched, shared by every call using it, those that arrive while it opens too; a failed open
 * is retried by the next call.
 */
export const makeIndexes = (options: { readonly idleMs: number; readonly open?: OpenFinder }): Indexes => {
  const open = options.open ?? openFff;
  const idleMs = Math.min(options.idleMs, MAX_TIMEOUT_MS);
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

  const acquire = (root: string): Index => {
    let index = indexes.get(root);
    if (index === undefined) {
      const opened: Index = { finder: open(root), users: 0, lastUsed: Date.now() };
      index = opened;
      indexes.set(root, opened);
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

  return {
    use: async (root, body) => {
      const index = acquire(root);
      try {
        const finder = await index.finder.catch((cause: unknown) => {
          throw new Error(`File search is unavailable here: ${message(cause)}`);
        });
        return await body(finder);
      } finally {
        release(root, index);
      }
    },
    snapshot: () =>
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
    close: () => [...indexes.keys()].forEach(close),
  };
};
