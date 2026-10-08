import { describe, expect, test } from "vitest";
import { compositionInfo } from "../src/composition.ts";

describe("compositionInfo", () => {
  const composition = { plugins: { a: { config: { x: 1, y: [1, 2] } }, b: {}, off: { enabled: false, config: { z: 1 } } } };

  test("lists running plugins by id and hashes ids, versions, and configs", () => {
    const info = compositionInfo(composition, [{ id: "b", version: "2.0.0" }, { id: "a" }]);
    expect(info.plugins).toEqual([{ id: "a" }, { id: "b", version: "2.0.0" }]);
    expect(info.id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across plugin order and config key order", () => {
    const one = compositionInfo(composition, [{ id: "a" }, { id: "b", version: "2.0.0" }]);
    const reordered = compositionInfo({ plugins: { b: {}, a: { config: { y: [1, 2], x: 1 } } } }, [{ id: "b", version: "2.0.0" }, { id: "a" }]);
    expect(reordered.id).toBe(one.id);
  });

  test("changes with any config, version, or member change", () => {
    const base = compositionInfo(composition, [{ id: "a" }, { id: "b" }]).id;
    expect(compositionInfo({ plugins: { ...composition.plugins, a: { config: { x: 2, y: [1, 2] } } } }, [{ id: "a" }, { id: "b" }]).id).not.toBe(base);
    expect(compositionInfo(composition, [{ id: "a", version: "1" }, { id: "b" }]).id).not.toBe(base);
    expect(compositionInfo(composition, [{ id: "a" }]).id).not.toBe(base);
    // Ids and configs cannot be confused by concatenation.
    expect(compositionInfo({ plugins: { ab: {} } }, [{ id: "ab" }]).id).not.toBe(compositionInfo({ plugins: { a: { config: "b" } } }, [{ id: "a" }]).id);
  });
});
