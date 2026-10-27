import { describe, expect, test } from "vitest";
import { createEntryStore } from "../src/entries.ts";
import type { KeyValueStorage } from "../src/entries.ts";

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
