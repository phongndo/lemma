import { describe, expect, it } from "vitest";
import { randomId, secureIds } from "../src/ids.ts";

describe("ids", () => {
  it("never start with -, which a command line would take for an option", () => {
    // 0xf8 encodes as `-` in base64url; the second draw is all zeros, `A…`.
    const draws = [new Uint8Array(9).fill(0xf8), new Uint8Array(9)];
    expect(randomId((size) => draws.shift()!.subarray(0, size), 9)).toBe("AAAAAAAAAAAA");
  });

  it("are url-safe and unpadded, as Node's base64url writes them", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 11) % 256);
    for (const size of [1, 2, 3, 6, 9, 64]) {
      const slice = bytes.subarray(0, size);
      const expected = Buffer.from(slice).toString("base64url");
      if (!expected.startsWith("-")) expect(randomId(() => slice, size)).toBe(expected);
    }
  });

  it("come from the system's secure source by default: 12 characters for 9 bytes, 8 for 6", () => {
    expect(randomId(secureIds, 9)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{11}$/);
    expect(randomId(secureIds, 6)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{7}$/);
  });
});
