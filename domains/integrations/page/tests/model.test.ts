import { describe, expect, it } from "vitest";
import type { IntegrationItem } from "@lemma/integrations";
import { dotted, filterItems, filterOffers, troubled } from "../src/model.ts";

const item = (id: string, tone: IntegrationItem["status"]["tone"], extra: Partial<IntegrationItem> = {}): IntegrationItem => ({
  id,
  title: id,
  status: { tone, text: tone },
  ...extra,
});

describe("the integrations list", () => {
  it("keeps the items matching every word of the filter, in their title, status, version, or keywords", () => {
    const items = [item("Claude Code", "ok", { version: "0.90.0" }), item("github", "error", { keywords: "npx server-github" }), item("OpenCode", "off")];
    expect(filterItems(items, "").map((kept) => kept.id)).toEqual(["Claude Code", "github", "OpenCode"]);
    expect(filterItems(items, "code").map((kept) => kept.id)).toEqual(["Claude Code", "OpenCode"]);
    expect(filterItems(items, "npx github").map((kept) => kept.id)).toEqual(["github"]);
    expect(filterItems(items, "0.90").map((kept) => kept.id)).toEqual(["Claude Code"]);
  });

  it("counts the items in error for its badge, and dots only trouble", () => {
    expect(troubled([item("a", "error"), item("b", "warn"), item("c", "ok")])).toBe(1);
    expect((["ok", "off", "busy", "warn", "error"] as const).filter(dotted)).toEqual(["warn", "error"]);
  });

  it("keeps the offers matching every word of a search, in their title, description, or keywords", () => {
    const offer = (id: string, description?: string, keywords?: string) => ({
      id,
      title: id,
      ...(description === undefined ? {} : { description }),
      ...(keywords === undefined ? {} : { keywords }),
      add: () => Promise.resolve(id),
    });
    const offers = [offer("Claude Code", "Anthropic's coding agent"), offer("Codex", "OpenAI's coding agent", "openai gpt"), offer("Goose")];
    expect(filterOffers(offers, " ").map((kept) => kept.id)).toEqual(["Claude Code", "Codex", "Goose"]);
    expect(filterOffers(offers, "coding agent").map((kept) => kept.id)).toEqual(["Claude Code", "Codex"]);
    expect(filterOffers(offers, "gpt").map((kept) => kept.id)).toEqual(["Codex"]);
  });
});
