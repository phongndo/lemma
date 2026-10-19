import type { DirectoryEntry } from "@lemma/workspace";

/** The folders a path lists (`workspace.browse`): those in `parent` that match the name typed after the last slash. */
export interface Listing {
  readonly parent: string;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

export type Row =
  /** The folder typed, when the path ends in a slash: opens it. */
  | { readonly kind: "here"; readonly path: string }
  /** `..`: goes up to `path`, highlighting `from`, the folder it leaves. */
  | { readonly kind: "up"; readonly path: string; readonly from: string }
  | { readonly kind: "entry"; readonly entry: DirectoryEntry }
  /** The name typed matches no folder: creates it. */
  | { readonly kind: "create"; readonly path: string };

/** The part after the last slash: what the listing is filtered by. */
export const needle = (typed: string): string => typed.slice(typed.lastIndexOf("/") + 1);

/**
 * The folder holding the one `typed` names, and that one's name, with `~` read as `home`; undefined at the disk's
 * root, or at `~` while `home` is unknown.
 */
export const above = (typed: string, home: string | undefined): { readonly path: string; readonly from: string } | undefined => {
  const trimmed = typed.replace(/\/+$/, "").replace(/^~(?=\/|$)/, () => home ?? "~");
  const cut = trimmed.lastIndexOf("/");
  return cut < 0 ? undefined : { path: trimmed.slice(0, cut) || "/", from: trimmed.slice(cut + 1) };
};

/**
 * The rows for what is `typed`. At a slash, the folder typed comes first, so Enter after going into a folder opens it,
 * then `..`; then the folders `listing` has, and for a name no folder has, a row creating it. The rows about the path
 * come from what is typed, the folders from the listing, which may still be the last path's.
 */
export const listRows = (typed: string, listing: Listing | undefined, home: string | undefined): Row[] => {
  const name = needle(typed);
  const out: Row[] = [];
  if (name === "" && typed !== "") {
    out.push({ kind: "here", path: typed });
    const to = above(typed, home);
    if (to !== undefined) out.push({ kind: "up", ...to });
  }
  if (listing === undefined) return out;
  out.push(...listing.entries.map((entry): Row => ({ kind: "entry", entry })));
  const exact = listing.entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (name !== "" && !exact) out.push({ kind: "create", path: typed });
  return out;
};
