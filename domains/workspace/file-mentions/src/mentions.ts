import { fuzzy } from "@lemma/web/match";
import type { FileEntry } from "@lemma/workspace";

/**
 * How a path is written after the trigger: as is, or quoted when it has
 * whitespace or quotes (`@"my notes/a b.md"`). `open` leaves a quoted one
 * unclosed, to go on typing inside it (a folder: `@"my notes/`).
 */
export const mentionPath = (path: string, options: { readonly open?: boolean } = {}): string =>
  /[\s"]/.test(path) ? `"${path.replace(/(["\\])/g, "\\$1")}${options.open === true ? "" : '"'}` : path;

interface FileSuggestionView {
  /** The last segment: a file's name, a directory's own. */
  readonly label: string;
  /** The folder it is in, without a trailing slash; empty at the top. */
  readonly detail: string;
  readonly matches: readonly number[];
  readonly detailMatches: readonly number[];
}

/**
 * A file entry split for a row, with the letters the query found marked.
 * Every token of the query is looked for in the whole path; tokens that do
 * not match in order (a typo, which the host's search forgives, or a glob)
 * mark nothing.
 */
export const fileView = (entry: FileEntry, query: string): FileSuggestionView => {
  const slash = entry.path.lastIndexOf("/");
  const label = entry.path.slice(slash + 1);
  const detail = slash === -1 ? "" : entry.path.slice(0, slash);
  const marked = new Set<number>();
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const index of fuzzy(entry.path, token)?.matches ?? []) marked.add(index);
  }
  const indices = [...marked].sort((a, b) => a - b);
  return {
    label,
    detail,
    matches: indices.filter((index) => index > slash).map((index) => index - slash - 1),
    detailMatches: indices.filter((index) => index < slash),
  };
};
