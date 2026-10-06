import { matchesQuery } from "./palette.ts";

/** A searchable entry in the settings view: `text` is everything a search can match. */
export interface Searchable {
  readonly text: string;
}

export interface EntryGroup<E extends Searchable> {
  readonly title?: string;
  readonly entries: readonly E[];
}

/** The groups' matching entries, dropping groups left empty. */
export const filterGroups = <E extends Searchable>(groups: readonly EntryGroup<E>[], query: string): EntryGroup<E>[] =>
  groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => matchesQuery(query, entry.text)) })).filter((group) => group.entries.length > 0);
