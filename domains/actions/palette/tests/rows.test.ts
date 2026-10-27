import { describe, expect, it } from "vitest";
import { RECENT_SHOWN, RESULTS, listRows, optionRows } from "../src/rows.ts";
import type { Found, Item, ItemSource, Row } from "../src/rows.ts";

const item = (key: string, title = key): Item => ({ key, title });
const source = (items: readonly Item[], options: { heading?: string; browse?: number } = {}): ItemSource => ({ items: () => items, ...options });
/** A row as a line: an item by its key and place, a heading or note by its label. */
const line = (row: Row) => (row.type === "item" ? `${row.index}:${row.item.key}` : `${row.type}:${row.label}`);

const commands = source([item("new", "New thread"), item("settings", "Open settings"), item("theme", "Change theme")]);
const threads = source([item("t1", "Fix the build"), item("t2", "Write the docs")], { heading: "Threads", browse: 1 });

describe("browsing", () => {
  it("leads with recent choices, then each source without them, up to its browse, under its heading", () => {
    const rows = listRows({ query: "", sources: [commands, threads], recent: ["t2", "gone", "theme"] });
    expect(rows.map(line)).toEqual(["heading:Recent", "0:t2", "1:theme", "2:new", "3:settings", "heading:Threads", "4:t1"]);
  });

  it("shows at most a few recent choices, and no section a source has nothing left for", () => {
    const many = source(Array.from({ length: 8 }, (_, n) => item(`c${n}`)));
    const rows = listRows({ query: "", sources: [many], recent: Array.from({ length: 8 }, (_, n) => `c${n}`) });
    expect(rows.filter((row) => row.type === "item")).toHaveLength(RECENT_SHOWN + 3);
    expect(listRows({ query: "", sources: [source([], { heading: "Empty" })], recent: [] })).toEqual([]);
  });

  it("on a page, lists the page's own items", () => {
    const page = source([item("dark"), item("light")]);
    expect(listRows({ query: "", sources: [commands], page, recent: ["new"] }).map(line)).toEqual(["0:dark", "1:light"]);
  });
});

describe("searching", () => {
  it("ranks every source's items, or the page's, with the letters matched", () => {
    const rows = listRows({ query: "theme", sources: [commands, threads], recent: [] });
    expect(rows.map(line)).toEqual(["0:theme"]);
    expect(rows[0]).toMatchObject({ matches: [7, 8, 9, 10, 11] });
    const page = source([item("dark", "Dark theme"), item("light", "Light")]);
    expect(listRows({ query: "theme", sources: [commands], page, recent: [] }).map(line)).toEqual(["0:dark"]);
  });

  it("keeps at most RESULTS of them", () => {
    const many = source(Array.from({ length: RESULTS + 10 }, (_, n) => item(`k${n}`, `thread ${n}`)));
    expect(listRows({ query: "thread", sources: [many], recent: [] })).toHaveLength(RESULTS);
  });

  it("adds what the sources' search found, but for what is listed already, under each source's label", () => {
    const found: Found = {
      text: "docs",
      labels: ["messages", "files"],
      groups: [
        { label: "messages", items: [item("t2", "Write the docs"), item("t9", "Old docs talk")] },
        { label: "files", items: [], error: "The index is not built" },
      ],
      pending: false,
    };
    const rows = listRows({ query: "docs ", sources: [threads], recent: [], found });
    expect(rows.map(line)).toEqual(["0:t2", "heading:In messages", "1:t9", "heading:In files", "note:The index is not built"]);
  });

  it("says a search is on its way, and leaves out what was found for other words", () => {
    const pending: Found = { text: "docs", labels: ["messages"], groups: [], pending: true };
    expect(listRows({ query: "docs", sources: [threads], recent: [], found: pending }).map(line)).toEqual(["0:t2", "note:Searching messages…"]);
    const stale: Found = { text: "doc", labels: ["messages"], groups: [{ label: "messages", items: [item("t9")] }], pending: false };
    expect(listRows({ query: "docs", sources: [threads], recent: [], found: stale }).map(line)).toEqual(["0:t2"]);
  });
});

describe("a question's options", () => {
  it("are ranked by what is typed, all of them with nothing typed", () => {
    const options = [item("yes", "Yes"), item("no", "No")];
    expect(optionRows(options, "").map(line)).toEqual(["0:yes", "1:no"]);
    expect(optionRows(options, "n").map(line)).toEqual(["0:no"]);
  });
});
