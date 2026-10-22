import { describe, expect, it } from "vitest";
import { matchesQuery } from "@lemma/web/match";
import { attentionOf, badgesOf, errorCount, filterGroups } from "../src/settings.ts";
import { SettingsRoute } from "@lemma/settings";

describe("SettingsRoute", () => {
  it("names the section in the path and keeps the section's state in the search", () => {
    expect(SettingsRoute.href({ section: "plugins" }, { plugin: "agent", kind: "host" })).toBe("/settings/plugins?plugin=agent&kind=host");
  });
});

describe("matchesQuery", () => {
  it("needs every word, in any order and case", () => {
    expect(matchesQuery("dark theme", "Theme: system, light or dark")).toBe(true);
    expect(matchesQuery("THEME", "Theme")).toBe(true);
    expect(matchesQuery("dark sepia", "Theme: light or dark")).toBe(false);
  });

  it("matches everything when the query is blank", () => {
    expect(matchesQuery("  ", "anything")).toBe(true);
  });
});

describe("filterGroups", () => {
  it("keeps matching entries and drops groups left empty", () => {
    const groups = [
      { title: "Connected", entries: [{ text: "Anthropic" }, { text: "OpenAI" }] },
      { title: "API keys", entries: [{ text: "Groq" }] },
    ];
    expect(filterGroups(groups, "open")).toEqual([{ title: "Connected", entries: [{ text: "OpenAI" }] }]);
    expect(filterGroups(groups, "")).toEqual(groups);
  });
});

describe("badges", () => {
  const section = (id: string, badge: string | undefined, badgeTone?: "error" | "info") => ({
    id,
    badge: () => badge,
    ...(badgeTone === undefined ? {} : { badgeTone }),
  });
  const sections = [section("about", "Update", "info"), section("general", undefined), section("integrations", "2"), section("plugins", "1 failed", "error")];

  it("lists the sections with a badge, errors first, an untoned one an error", () => {
    expect(badgesOf(sections).map((badge) => [badge.section.id, badge.tone])).toEqual([
      ["integrations", "error"],
      ["plugins", "error"],
      ["about", "info"],
    ]);
  });

  it("counts only the errors, each by its leading number or as one", () => {
    expect(errorCount(badgesOf(sections))).toBe(3);
    expect(errorCount(badgesOf([section("mcp", "Offline")]))).toBe(1);
    expect(errorCount(badgesOf([section("about", "Update", "info")]))).toBe(0);
  });

  it("says a bare count needs attention, and keeps a badge's own words", () => {
    expect(attentionOf("1")).toBe("1 needs attention");
    expect(attentionOf("2")).toBe("2 need attention");
    expect(attentionOf("1 failed")).toBe("1 failed");
  });
});
