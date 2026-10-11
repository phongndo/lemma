import { describe, expect, it } from "vitest";
import { contextSize } from "../src/context-size.ts";

describe("contextSize", () => {
  it("abbreviates token counts", () => {
    expect(contextSize(1_000_000)).toBe("1M");
    expect(contextSize(1_048_576)).toBe("1M");
    expect(contextSize(203_000)).toBe("203K");
    expect(contextSize(2_500_000)).toBe("2.5M");
  });
});
