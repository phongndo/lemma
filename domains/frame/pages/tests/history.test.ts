import { describe, expect, it } from "vitest";
import { ahead, see } from "../src/history.ts";
import type { Entry, Seen } from "../src/history.ts";

/** Where the page has been, in order. */
const walk = (...entries: Entry[]): Seen => entries.reduce<Seen | undefined>(see, undefined)!;

describe("what is ahead in the history", () => {
  it("is nothing at first, nor after going somewhere new", () => {
    expect(ahead(walk({ index: 0, key: "a" }))).toBe(false);
    expect(ahead(walk({ index: 0, key: "a" }, { index: 1, key: "b" }))).toBe(false);
  });

  it("is where the page came back from, until it goes forward to it", () => {
    const back = walk({ index: 0, key: "a" }, { index: 1, key: "b" }, { index: 2, key: "c" }, { index: 1, key: "b" });
    expect(ahead(back)).toBe(true);
    expect(ahead(see(back, { index: 2, key: "c" }))).toBe(false);
    expect(ahead(see(see(back, { index: 0, key: "a" }), { index: 1, key: "b" }))).toBe(true);
  });

  it("is dropped by going somewhere new from the middle", () => {
    const back = walk({ index: 0, key: "a" }, { index: 1, key: "b" }, { index: 2, key: "c" }, { index: 0, key: "a" });
    const pushed = see(back, { index: 1, key: "d" });
    expect(ahead(pushed)).toBe(false);
    // Back from it, it is ahead; forward to it again, what was after the middle is gone.
    const again = see(pushed, { index: 0, key: "a" });
    expect(ahead(again)).toBe(true);
    expect(ahead(see(again, { index: 1, key: "d" }))).toBe(false);
  });

  it("keeps an entry first seen by going back, as after a reload", () => {
    const reloaded = walk({ index: 3, key: "d" }, { index: 2, key: "c" });
    expect(ahead(reloaded)).toBe(true);
  });

  it("is unchanged by the current entry being rewritten", () => {
    const back = walk({ index: 0, key: "a" }, { index: 1, key: "b" }, { index: 0, key: "a" });
    expect(ahead(see(back, { index: 0, key: "a" }))).toBe(true);
  });
});
