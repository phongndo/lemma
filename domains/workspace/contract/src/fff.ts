/**
 * Node only: `@lemma/workspace/fff`. fff's indexes of the directories searched, which `workspace.search-fff` opens and
 * keeps: it searches files with them (`FileSearchers`), and the `grep` and `find` tools (`tools.search-fff`) search
 * with them too, so a directory both search is indexed once.
 */
import type { FileFinderApi } from "@ff-labs/fff-node";
import { Context } from "effect";

/** A directory's index: fff's `FileFinder`, contents indexed, kept current by fff's watcher. Its owner closes it. */
export type FffIndex = Omit<FileFinderApi, "destroy" | "reindex">;

export interface FffIndexesService {
  /**
   * Runs `body` with the index of `root`, an existing directory with symlinks resolved, opening it on first use: one
   * per directory, shared by every call using it, and closed once none has for the owner's `idleMinutes`. Rejects when
   * fff cannot index there (its native library missing, a directory it refuses), and the next call tries again.
   */
  readonly use: <A>(root: string, body: (index: FffIndex) => Promise<A>) => Promise<A>;
}

/** The fff indexes: `workspace.search-fff` provides it; a plugin providing it replaces that plugin. */
export class FffIndexes extends Context.Service<FffIndexes, FffIndexesService>()("lemma/FffIndexes") {}
