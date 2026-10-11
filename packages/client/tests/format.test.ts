import { describe, expect, test } from "vitest";
import { formatCost, formatDuration, formatTokens } from "../src/format.ts";

describe("format", () => {
  test("writes figures compactly", () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(45_600), formatTokens(2_500_000)]).toEqual(["950", "1.2k", "46k", "2.50M"]);
    expect([formatCost(0), formatCost(0.00123), formatCost(0.123), formatCost(12.3)]).toEqual(["$0", "$0.0012", "$0.123", "$12.30"]);
    expect([formatDuration(420), formatDuration(4200), formatDuration(42_000), formatDuration(125_000), formatDuration(3_780_000)]).toEqual([
      "420ms",
      "4.2s",
      "42s",
      "2m 5s",
      "1h 3m",
    ]);
  });
});
