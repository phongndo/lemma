import type { PaletteItem } from "@lemma/actions";
import { rank } from "@lemma/web/match";
import type { Searchable } from "@lemma/web/match";

/** A row: a source's item, or an option of a question (which has nothing to run). */
export type Item = Omit<PaletteItem, "run"> & Searchable & { readonly run?: PaletteItem["run"] };

/** A line of the list: a section's name, a note, or an item with the title letters the search matched and its place among the items. */
export type Row =
  | { readonly type: "heading"; readonly label: string }
  | { readonly type: "note"; readonly label: string }
  | { readonly type: "item"; readonly item: Item; readonly matches: readonly number[]; readonly index: number };

/** What the sources' `search` found for `text`, by source; `pending` until each has answered. */
export interface Found {
  readonly text: string;
  readonly labels: readonly string[];
  readonly groups: readonly { readonly label: string; readonly items: readonly Item[]; readonly error?: string }[];
  readonly pending: boolean;
}

/** Where items come from: a source at the top level, or the page shown. Its items are read only when the list needs them. */
export interface ItemSource {
  readonly items: () => readonly Item[];
  /** What its items browse under; none leads unnamed. */
  readonly heading?: string | undefined;
  /** How many of its items browse; all without it. */
  readonly browse?: number | undefined;
}

/** At most this many items match what is typed, before what the sources' `search` found. */
export const RESULTS = 60;
/** How many recent choices lead the list while browsing. */
export const RECENT_SHOWN = 5;

/** A question's options that match `filter`, ranked. */
export const optionRows = (options: readonly Item[], filter: string): Row[] =>
  rank(options, filter).map((ranked, index) => ({ type: "item", item: ranked.item, matches: ranked.matches, index }));

/**
 * The rows for what is typed (`query`), at the top level (every source's items) or on a page (`page`, its own). With
 * something typed: the items that match it, ranked (`recent` choices a little higher), at most `RESULTS`, then what
 * the sources' `search` found (`found`, while it answers what is typed), but for what is listed already, under `In`
 * its label, or a note while it is on its way or why it failed. On a page with nothing typed: its items. Browsing
 * the top level: up to `RECENT_SHOWN` recent choices under Recent, then each source's items without them, up to its
 * `browse`, under its `heading`. Items are numbered in order (`index`), past the headings and notes.
 */
export const listRows = (input: {
  readonly query: string;
  readonly sources: readonly ItemSource[];
  readonly page?: ItemSource | undefined;
  readonly recent: readonly string[];
  readonly found?: Found | undefined;
}): Row[] => {
  const { query, sources, page, recent, found } = input;
  /** What a search at the top level looks through: every source's items. */
  const pool = (): Item[] => sources.flatMap((source) => [...source.items()]);
  let index = 0;
  const item = (entry: { item: Item; matches: readonly number[] }): Row => ({ type: "item", ...entry, index: index++ });
  if (query.trim() !== "") {
    const ranked = rank(page === undefined ? pool() : [...page.items()], query, recent)
      .slice(0, RESULTS)
      .map(item);
    // Then what the sources found elsewhere (`search`), but for what is listed already.
    if (found === undefined || found.text !== query.trim()) return ranked;
    if (found.pending) return [...ranked, { type: "note", label: `Searching ${found.labels.join(" and ")}…` }];
    const listed = new Set(ranked.flatMap((row) => (row.type === "item" ? [row.item.key] : [])));
    return [
      ...ranked,
      ...found.groups.flatMap((group): Row[] => {
        if (group.error !== undefined)
          return [
            { type: "heading", label: `In ${group.label}` },
            { type: "note", label: group.error },
          ];
        const items = group.items.filter((entry) => !listed.has(entry.key));
        return items.length === 0 ? [] : [{ type: "heading", label: `In ${group.label}` }, ...items.map((entry) => item({ item: entry, matches: [] }))];
      }),
    ];
  }
  if (page !== undefined) return page.items().map((entry) => item({ item: entry, matches: [] }));
  // Browsing: recent choices, then each source in order, up to its `browse` (the commands, and what plugins add;
  // threads and projects show as a search finds them).
  const byKey = new Map(pool().map((entry) => [entry.key, entry]));
  const recentItems = recent
    .map((key) => byKey.get(key))
    .filter((entry): entry is Item => entry !== undefined)
    .slice(0, RECENT_SHOWN);
  const listed = new Set(recentItems.map((entry) => entry.key));
  // A source without a heading (commands) leads; the others are named so the switch from actions to places is visible.
  const section = (label: string | undefined, items: readonly Item[]): Row[] =>
    items.length === 0
      ? []
      : [...(label === undefined ? [] : [{ type: "heading" as const, label }]), ...items.map((entry) => item({ item: entry, matches: [] }))];
  return [
    ...section("Recent", recentItems),
    ...sources.flatMap((source) =>
      section(
        source.heading,
        source
          .items()
          .filter((entry) => !listed.has(entry.key))
          .slice(0, source.browse ?? Number.POSITIVE_INFINITY),
      ),
    ),
  ];
};
