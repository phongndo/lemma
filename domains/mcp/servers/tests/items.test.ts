import { describe, expect, it } from "vitest";
import type { ServerItem } from "../src/items.ts";
import { dotted, filterItems, troubled } from "../src/items.ts";

const item = (id: string, tone: ServerItem["status"]["tone"], extra: Partial<ServerItem> = {}): ServerItem => ({
  id,
  title: id,
  status: { tone, text: tone },
  enabled: true,
  setEnabled: () => {},
  keywords: "",
  ...extra,
});

describe("the servers' list", () => {
  it("keeps the items matching every word of the filter, in their title, status, version, or keywords", () => {
    const items = [item("filesystem", "ok", { version: "0.2.0" }), item("github", "error", { keywords: "npx server-github" }), item("file-notes", "off")];
    expect(filterItems(items, "").map((kept) => kept.id)).toEqual(["filesystem", "github", "file-notes"]);
    expect(filterItems(items, "file").map((kept) => kept.id)).toEqual(["filesystem", "file-notes"]);
    expect(filterItems(items, "npx github").map((kept) => kept.id)).toEqual(["github"]);
    expect(filterItems(items, "0.2").map((kept) => kept.id)).toEqual(["filesystem"]);
  });

  it("counts the items in error for its badge, and dots only trouble", () => {
    expect(troubled([item("a", "error"), item("b", "warn"), item("c", "ok")])).toBe(1);
    expect((["ok", "off", "busy", "warn", "error"] as const).filter(dotted)).toEqual(["warn", "error"]);
  });
});
