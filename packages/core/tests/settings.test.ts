import * as Effect from "effect";
import { describe, expect, test } from "vitest";
import { runtimeSettings } from "../src/internal/settings.ts";

describe("runtime settings", () => {
  test("every reference the effect module exports is one, so a new Effect release cannot add one unnoticed", () => {
    const references = new Set<string>();
    for (const module of Object.values(Effect as Record<string, unknown>)) {
      if (module === null || typeof module !== "object") continue;
      for (const value of Object.values(module as Record<string, unknown>)) {
        if (Effect.Context.isKey(value) && Effect.Context.isReference(value)) references.add(value.key);
      }
    }
    expect(references.size).toBeGreaterThan(20);
    expect([...references].filter((key) => !runtimeSettings.has(key))).toEqual([]);
  });
});
