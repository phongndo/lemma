import { Data, Effect, Schema } from "effect";
import type { Context } from "effect";
import { Registry } from "@lemma/core";
import type { Registries } from "@lemma/core";

/** The most entries one search returns: providers answer on the host's thread, so a page stays small. */
export const FILE_SEARCH_LIMIT = 200;

/** What a search looks for: files, directories, or both (the default), ranked together. */
export const FileKind = Schema.Literal("file", "directory");
export type FileKind = typeof FileKind.Type;

export const FileEntry = Schema.Struct({
  /** Relative to the directory searched, with `/` separators and no trailing slash. */
  path: Schema.String,
  kind: FileKind,
});
export type FileEntry = typeof FileEntry.Type;

export const FileSearchOptions = Schema.Struct({
  /** At most this many entries, up to `FILE_SEARCH_LIMIT`; default 50. */
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, FILE_SEARCH_LIMIT))),
  /** Only files or only directories; both when absent. */
  kind: Schema.optional(FileKind),
  /**
   * Only entries inside this folder of the directory searched (`src/lib`, `/`-separated, relative); entries stay
   * relative to the directory searched, and the folder itself is not one.
   */
  within: Schema.optional(Schema.String),
});
export type FileSearchOptions = typeof FileSearchOptions.Type;

export const FileSearchResult = Schema.Struct({
  /** The absolute directory searched, `~` expanded. */
  root: Schema.String,
  /** Best match first. */
  entries: Schema.Array(FileEntry),
  /** More matched than were returned. */
  truncated: Schema.Boolean,
  /** The directory was still being read: entries may be missing. */
  indexing: Schema.optional(Schema.Boolean),
});
export type FileSearchResult = typeof FileSearchResult.Type;

/**
 * `NotFound`: the path is not a directory, or `within` is not a folder in it.
 * `Unavailable`: nothing can search here (no plugin searches files, its engine
 * did not load, or it refuses the directory). `Failed`: anything else.
 */
export class FileSearchError extends Data.TaggedError("FileSearchError")<{
  readonly path: string;
  readonly reason: "NotFound" | "Unavailable" | "Failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Finds files in a directory by a typed query, for mentions in a prompt and
 * any picker. How a query matches is the provider's: the bundled one is fuzzy,
 * typo-tolerant, and honours `.gitignore`. An empty query lists entries in the
 * provider's own order (the bundled one: most recently changed first).
 */
export interface FileSearcher {
  /** Names it, by convention its plugin's id; one plugin contributes one. */
  readonly id: string;
  readonly search: (cwd: string, query: string, options?: FileSearchOptions) => Effect.Effect<FileSearchResult, FileSearchError>;
}

/**
 * Who searches files: the first contribution by order answers (`searchFiles`).
 * The `file-search` plugin is the bundled one; a plugin replaces it by
 * contributing with a lower order (`PluginContext.add(FileSearchers, …, { order })`),
 * or by its being turned off. With none, searches fail `Unavailable`, and
 * nothing else stops: the transport reads this rather than requiring it.
 */
export const FileSearchers = Registry.make<FileSearcher>("lemma/file-searchers", { key: (searcher) => searcher.id });

/** Searches with the first of `FileSearchers`; `Unavailable` when no plugin contributes one. */
export const searchFiles = (
  registries: Context.Tag.Service<Registries>,
  cwd: string,
  query: string,
  options?: FileSearchOptions,
): Effect.Effect<FileSearchResult, FileSearchError> =>
  Effect.flatMap(registries.items(FileSearchers), ([first]) =>
    first === undefined
      ? Effect.fail(new FileSearchError({ path: cwd, reason: "Unavailable", message: "No plugin searches files: turn on file-search, or add one" }))
      : first.item.search(cwd, query, options),
  );
