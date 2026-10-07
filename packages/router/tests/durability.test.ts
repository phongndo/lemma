import { describe, expect, test } from "vitest";
import { createEntryStore } from "../src/entries.ts";
import type { KeyValueStorage } from "../src/entries.ts";
import { createMemoryHistory } from "../src/history.ts";
import type { HistorySnapshot } from "../src/history.ts";
import { defineRoute } from "../src/route.ts";
import type { AnyRoute } from "../src/route.ts";
import { createNavigator, createRouteTable } from "../src/router.ts";

/** A storage that keeps strings, and can be told to refuse writes as a full one does. */
const memoryStorage = () => {
  const items = new Map<string, string>();
  let full = false;
  const storage: KeyValueStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (full) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
  };
  return { storage, items, fill: () => (full = true) };
};

describe("a memory history's snapshot", () => {
  test("restores the stack, its keys, and where it was", () => {
    const history = createMemoryHistory("/a");
    history.push("/b?x=1");
    history.push("/c#top");
    history.go(-1);
    const saved = JSON.parse(JSON.stringify(history.snapshot())) as HistorySnapshot;
    const restored = createMemoryHistory(saved);
    expect(restored.location()).toEqual(history.location());
    restored.go(1);
    expect(restored.location().href).toBe("/c#top");
    expect(restored.snapshot().entries.map((entry) => entry.key)).toEqual(history.snapshot().entries.map((entry) => entry.key));
  });

  test("takes what it can trust from a damaged one", () => {
    const damaged = {
      entries: [{ href: "/a", key: "k1" }, { href: 42 }, null, { href: "/b", key: "k1" }, { href: "https://elsewhere.example/c?q", key: "k3" }],
      index: 99,
    } as unknown as HistorySnapshot;
    const restored = createMemoryHistory(damaged);
    const { entries, index } = restored.snapshot();
    // Another site's URL is not an entry here: dropped, not rewritten to a path.
    expect(entries.map((entry) => entry.href)).toEqual(["/a", "/b"]);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
    expect(entries[0]!.key).toBe("k1");
    expect(index).toBe(1);
    expect(createMemoryHistory({ entries: [], index: 0 }).location().href).toBe("/");
    // The index names the saved entry, not a position among those kept: dropping one before it does not move it.
    const shifted = createMemoryHistory({
      entries: [{ href: 42 }, { href: "/a", key: "a" }, { href: "/b", key: "b" }],
      index: 1,
    } as unknown as HistorySnapshot);
    expect(shifted.location().href).toBe("/a");
    // A current entry that was dropped lands on the last kept before it.
    expect(
      createMemoryHistory({
        entries: [
          { href: "/a", key: "a" },
          { href: "//evil.example/x", key: "x" },
          { href: "/c", key: "c" },
        ],
        index: 1,
      }).location().href,
    ).toBe("/a");
    expect(createMemoryHistory(null as unknown as HistorySnapshot).location().href).toBe("/");
  });
});

describe("an entry store", () => {
  test("keeps state by entry across a reload, dropping the least recently written past its limit", () => {
    const { storage } = memoryStorage();
    const store = createEntryStore({ storage, limit: 2 });
    let heard = 0;
    store.subscribe(() => heard++);
    store.set("e1", "scroll", 10);
    store.set("e2", "scroll", 20);
    store.set("e1", "draft", "hi");
    store.set("e3", "scroll", 30);
    expect(heard).toBe(4);
    const reloaded = createEntryStore({ storage, limit: 2 });
    expect(reloaded.all()).toEqual({ e1: { scroll: 10, draft: "hi" }, e3: { scroll: 30 } });
    expect(reloaded.get<number>("e3", "scroll")).toBe(30);
  });

  test("a refused write, or unreadable storage, keeps state for the page's life", () => {
    const { storage, items, fill } = memoryStorage();
    items.set("router.entries", "{not json");
    const store = createEntryStore({ storage });
    expect(store.all()).toEqual({});
    fill();
    store.set("e1", "scroll", 5);
    expect(store.get("e1", "scroll")).toBe(5);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => store.set("e1", "cyclic", cyclic)).not.toThrow();
    items.set("router.entries", JSON.stringify({ e1: 3, e2: { ok: true }, e3: [1] }));
    expect(createEntryStore({ storage }).all()).toEqual({ e2: { ok: true } });
  });
});

describe("an entry store, at its edges", () => {
  test("drops the least recently written, keys that look like numbers too", () => {
    const store = createEntryStore({ limit: 2 });
    store.set("1", "x", 1);
    store.set("2", "x", 2);
    store.set("1", "x", 3);
    store.set("3", "x", 4);
    expect(Object.keys(store.all()).sort()).toEqual(["1", "3"]);
  });

  test("one value JSON cannot hold stays in memory without keeping the rest from being saved", () => {
    const { storage } = memoryStorage();
    const store = createEntryStore({ storage });
    store.set("e1", "big", 10n);
    store.set("e2", "scroll", 7);
    const reloaded = createEntryStore({ storage });
    expect(reloaded.get("e2", "scroll")).toBe(7);
    expect(reloaded.get("e1", "big")).toBeUndefined();
    expect(store.get("e1", "big")).toBe(10n);
  });

  test("a value too big for what the storage has left stays in memory without keeping the rest from being saved", () => {
    const items = new Map<string, string>();
    // A quota of 200 characters.
    const storage: KeyValueStorage = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (value.length > 200) throw new Error("QuotaExceededError");
        items.set(key, value);
      },
    };
    const store = createEntryStore({ storage });
    store.set("e1", "scroll", 1);
    store.set("e2", "draft", "x".repeat(500));
    store.set("e1", "scroll", 2);
    store.set("e3", "scroll", 3);
    const reloaded = createEntryStore({ storage });
    expect(reloaded.all()).toEqual({ e2: {}, e1: { scroll: 2 }, e3: { scroll: 3 } });
    expect(store.get("e2", "draft")).toHaveLength(500);
    // Written again small enough, it is saved.
    store.set("e2", "draft", "short");
    expect(createEntryStore({ storage }).get("e2", "draft")).toBe("short");
  });

  test("restored, it keeps no more than its limit, the most recently written", () => {
    const { storage } = memoryStorage();
    const writer = createEntryStore({ storage, limit: 10 });
    for (let n = 1; n <= 6; n++) writer.set(`e${n}`, "scroll", n);
    expect(Object.keys(createEntryStore({ storage, limit: 2 }).all())).toEqual(["e5", "e6"]);
  });

  test("reads only what was stored, and a listener that throws does not keep the others from hearing", () => {
    const errors: unknown[] = [];
    const store = createEntryStore({ onError: (error) => errors.push(error) });
    store.set("e1", "scroll", 1);
    expect(store.get("e1", "constructor")).toBeUndefined();
    expect(store.get("e1", "toString")).toBeUndefined();
    let heard = 0;
    store.subscribe(() => {
      throw new Error("listener broke");
    });
    store.subscribe(() => heard++);
    store.set("e1", "scroll", 2);
    expect(heard).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("crash and restore", () => {
  test("a navigator rebuilt from what was saved shows the same page, with its entries' state and its back and forward", () => {
    const Item = defineRoute("item", { path: "/items/:id", search: { tab: "info" } });
    const table = createRouteTable<{ readonly route: AnyRoute }>();
    table.setEntries([{ route: Item }]);
    const { storage, items } = memoryStorage();
    const store = createEntryStore({ storage });
    const history = createMemoryHistory("/items/1");
    const navigator = createNavigator(table, { history });
    navigator.navigate(Item, { id: "2" }, { search: { tab: "files" } });
    store.set(navigator.location().key, "scroll", 120);
    navigator.navigate(Item, { id: "3" });
    navigator.back();
    // What the app saved as it went, and nothing else, survives the crash.
    const saved = JSON.stringify(history.snapshot());
    navigator.destroy();

    const again = createNavigator(table, { history: createMemoryHistory(JSON.parse(saved) as HistorySnapshot) });
    const restoredStore = createEntryStore({ storage });
    expect(again.matchOf(Item)).toEqual({ params: { id: "2" }, search: { tab: "files" } });
    expect(restoredStore.get(again.location().key, "scroll")).toBe(120);
    again.go(1);
    expect(again.matchOf(Item)?.params.id).toBe("3");
    again.go(-2);
    expect(again.matchOf(Item)?.params.id).toBe("1");
    expect(items.size).toBe(1);
  });
});
