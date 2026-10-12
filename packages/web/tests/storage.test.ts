import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJson, loadStrings, recordOf } from "../src/storage.ts";

const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
});
afterEach(() => stored.clear());

describe("what a plugin reads back from storage", () => {
  it("is the value only when it has the shape asked for: another plugin's, or an older version's, under the key is not", () => {
    const isNumber = (value: unknown): value is number => typeof value === "number";
    stored.set("k", "3");
    expect(loadJson("k", 0, isNumber)).toBe(3);
    // What another plugin keeps under the same key (frame.shell's "1" was the sidebar's crash).
    stored.set("k", '"1"');
    expect(loadJson("k", 0, isNumber)).toBe(0);
    stored.set("k", "{not json");
    expect(loadJson("k", 0, isNumber)).toBe(0);
    expect(loadJson("absent", 0, isNumber)).toBe(0);
    stored.set("r", '{"a":1,"b":"x"}');
    expect(loadJson("r", {}, recordOf(isNumber))).toEqual({});
    stored.set("r", '{"a":1}');
    expect(loadJson("r", {}, recordOf(isNumber))).toEqual({ a: 1 });
  });

  it("reads a list of strings, leaving out what is not one", () => {
    stored.set("l", '["a",2,"b"]');
    expect(loadStrings("l")).toEqual(["a", "b"]);
    stored.set("l", '{"a":"b"}');
    expect(loadStrings("l")).toEqual([]);
    stored.set("l", "1");
    expect(loadStrings("l")).toEqual([]);
  });
});
