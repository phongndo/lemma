import { matchesQuery } from "@lemma/web/match";
import type { IntegrationItem, IntegrationOffer } from "@lemma/integrations";

/** The items a filter keeps: those whose title, version, status, or keywords match every word of it. */
export const filterItems = (items: readonly IntegrationItem[], query: string): readonly IntegrationItem[] =>
  query.trim() === "" ? items : items.filter((item) => matchesQuery(query, `${item.title} ${item.version ?? ""} ${item.status.text} ${item.keywords ?? ""}`));

/** How many items are in trouble: the section's badge. */
export const troubled = (items: readonly IntegrationItem[]): number => items.filter((item) => item.status.tone === "error").length;

/** Whether the tone gets a dot on its row: only trouble does. */
export const dotted = (tone: IntegrationItem["status"]["tone"]): boolean => tone === "warn" || tone === "error";

/** The offers a search keeps: those whose title, description, or keywords match every word of it. */
export const filterOffers = (offers: readonly IntegrationOffer[], query: string): readonly IntegrationOffer[] =>
  query.trim() === "" ? offers : offers.filter((offer) => matchesQuery(query, `${offer.title} ${offer.description ?? ""} ${offer.keywords ?? ""}`));
