import { describe, expect, it } from "vitest";
import { ahead, see } from "../src/history.ts";
import type { Seen } from "../src/history.ts";

/** A move: to a place in the history, by a push or not. */
type Move = readonly [index: number, pushed: boolean];

/** Where the page has been, in order. */
const walk = (...moves: Move[]): Seen => moves.reduce<Seen | undefined>((seen, [index, pushed]) => see(seen, index, pushed), undefined)!;

describe("what is ahead in the history", () => {
  it("is nothing at first, nor after going somewhere new", () => {
    expect(ahead(walk([0, false]))).toBe(false);
    expect(ahead(walk([0, false], [1, true]))).toBe(false);
  });

  it("is where the page came back from, until it goes forward to it", () => {
    const back = walk([0, false], [1, true], [2, true], [1, false]);
    expect(ahead(back)).toBe(true);
    expect(ahead(see(back, 2, false))).toBe(false);
    expect(ahead(see(see(back, 0, false), 1, false))).toBe(true);
  });

  it("is dropped by going somewhere new from the middle", () => {
    const pushed = see(walk([0, false], [1, true], [2, true], [0, false]), 1, true);
    expect(ahead(pushed)).toBe(false);
    // Back from it, it is ahead; forward to it again, what was after the middle is gone.
    const again = see(pushed, 0, false);
    expect(ahead(again)).toBe(true);
    expect(ahead(see(again, 1, false))).toBe(false);
  });

  it("keeps what is ahead when going forward onto an entry never seen, as after a reload and a jump back", () => {
    // Reloaded at D (3), jumped back to B (1), then forward to C (2), never seen: D is still ahead.
    const forward = walk([3, false], [1, false], [2, false]);
    expect(ahead(forward)).toBe(true);
  });

  it("is unchanged by the current entry being rewritten, or pushed to again as the same address", () => {
    const back = walk([0, false], [1, true], [0, false]);
    expect(ahead(see(back, 0, false))).toBe(true);
    expect(ahead(see(back, 0, true))).toBe(true);
  });
});
