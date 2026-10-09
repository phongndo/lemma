import { describe, expect, it } from "vitest";
import { matchesQuery } from "../src/model/palette.ts";
import { filterGroups } from "../src/model/settings.ts";
import { SettingsRoute } from "../src/ui/contracts.ts";

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
