import { describe, expect, it } from "vitest";
import { NEAR_END, createStickToBottom } from "../src/scroll.ts";

/** A scroller of `height` showing `client` of it, which scrolls as an element does: within its range. */
const scroller = (height: number, client = 100) => {
  const element = {
    scrollHeight: height,
    clientHeight: client,
    scrollTop: 0,
    scrollTo: ({ top }: { top: number }) => {
      element.scrollTop = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
    },
  };
  return element;
};
const settled = () => new Promise<void>((done) => queueMicrotask(done));

describe("createStickToBottom", () => {
  it("follows from the start, and keeps the end in view as what it shows grows", async () => {
    const element = scroller(500);
    const stick = createStickToBottom(() => element as unknown as HTMLElement);
    expect(stick.stuck()).toBe(true);
    stick.keep();
    await settled();
    expect(element.scrollTop).toBe(400);
    element.scrollHeight = 800;
    stick.keep();
    await settled();
    expect(element.scrollTop).toBe(700);
  });

  it("stops when the reader scrolls up, not when output outgrows it, and follows again at the end", async () => {
    const element = scroller(500);
    const stick = createStickToBottom(() => element as unknown as HTMLElement);
    stick.follow();
    await settled();
    // Output arrived before the scroll that follows it: the end moved away, but the reader did not scroll up.
    element.scrollHeight = 900;
    stick.onScroll();
    expect(stick.stuck()).toBe(true);
    element.scrollTop = 300;
    stick.onScroll();
    expect(stick.stuck()).toBe(false);
    stick.keep();
    await settled();
    expect(element.scrollTop).toBe(300);
    element.scrollTop = 800 - NEAR_END + 1;
    stick.onScroll();
    expect(stick.stuck()).toBe(true);
  });

  it("follows a place the view put it at only if that is the end, and lets go when told", async () => {
    const element = scroller(500);
    const stick = createStickToBottom(() => element as unknown as HTMLElement);
    element.scrollTop = 120;
    stick.placed();
    expect(stick.stuck()).toBe(false);
    expect(stick.lastTop()).toBe(120);
    element.scrollTop = 400;
    stick.placed();
    expect(stick.stuck()).toBe(true);
    stick.release();
    expect(stick.stuck()).toBe(false);
    stick.follow(true);
    expect(stick.stuck()).toBe(true);
  });
});
