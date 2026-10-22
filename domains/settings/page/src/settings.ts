import { matchesQuery } from "@lemma/web/match";

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

/** What a section's badge says, and whether it is trouble (`error`) or news (`info`). */
export interface Badge<S> {
  readonly section: S;
  readonly text: string;
  readonly tone: "error" | "info";
}

/** The sections showing a badge, the errors first (an untoned badge is one), each kind in the sections' order. */
export const badgesOf = <S extends { readonly badge?: () => string | undefined; readonly badgeTone?: "error" | "info" }>(sections: readonly S[]): Badge<S>[] =>
  sections
    .flatMap((section): Badge<S>[] => {
      const text = section.badge?.();
      return text === undefined ? [] : [{ section, text, tone: section.badgeTone ?? "error" }];
    })
    .sort((a, b) => Number(a.tone === "info") - Number(b.tone === "info"));

/** How many the settings button counts for error badges: each one's leading number (`2`, `1 failed`), else one. */
export const errorCount = (badges: readonly Badge<unknown>[]): number =>
  badges.reduce((sum, badge) => sum + (badge.tone === "error" ? Number.parseInt(badge.text, 10) || 1 : 0), 0);

/** An error badge as the settings button's menu says it: a bare count needs attention (`2 need attention`); else as it is (`1 failed`). */
export const attentionOf = (text: string): string => {
  const count = text.trim();
  return /^\d+$/.test(count) ? `${count} ${count === "1" ? "needs" : "need"} attention` : text;
};
