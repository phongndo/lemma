import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";

/**
 * How near its end, in pixels, a scroller counts as at it: about a line. Only a scroll up stops following, so
 * output that grows faster than it is followed does not; the distance decides how far up a reader may scroll and
 * still be pulled back down, and a line is little enough that scrolling up to read the last one lets it go.
 */
export const NEAR_END = 24;

/** A scroller that follows its end, as a log or a chat does (`createStickToBottom`). */
export interface StickToBottom {
  /** Whether it follows its end: what is added keeps the end in view. Reactive. */
  readonly stuck: Accessor<boolean>;
  /** The scroller's `onScroll`: at the end, it follows; scrolled up, it stops. */
  readonly onScroll: () => void;
  /** Where the scroller was at its last scroll, or its last move of its own: a place to go back to. */
  readonly lastTop: () => number;
  /** Goes to the end, once what is changing now is drawn (`smooth` animates it), and follows it. */
  readonly follow: (smooth?: boolean) => void;
  /** What it shows changed: back to the end, while it follows. */
  readonly keep: () => void;
  /** The view put the scroller somewhere itself (a jump, a place restored): it follows if that is the end. */
  readonly placed: () => void;
  /** Stops following, until the reader scrolls to the end or something calls `follow`. */
  readonly release: () => void;
}

/**
 * Keeps `scroller` at its end while the reader leaves it there: it follows from the start, stops when the reader
 * scrolls up, and follows again at the end (`NEAR_END`). The scroller's `onScroll` is `onScroll`; what changes what
 * it shows calls `keep`.
 */
export const createStickToBottom = (scroller: () => HTMLElement | undefined): StickToBottom => {
  const [stuck, setStuck] = createSignal(true);
  let lastTop = 0;
  const atEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END;
  const toEnd = (smooth: boolean) =>
    queueMicrotask(() => {
      const element = scroller();
      if (element === undefined) return;
      element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      // Its own move, kept now: one scroll event may cover it and the reader's scroll up after it.
      lastTop = element.scrollTop;
    });
  return {
    stuck,
    onScroll: () => {
      const element = scroller();
      if (element === undefined) return;
      if (atEnd(element)) setStuck(true);
      else if (element.scrollTop < lastTop) setStuck(false);
      lastTop = element.scrollTop;
    },
    lastTop: () => lastTop,
    follow: (smooth = false) => {
      setStuck(true);
      toEnd(smooth);
    },
    keep: () => {
      if (stuck()) toEnd(false);
    },
    placed: () => {
      const element = scroller();
      if (element === undefined) return;
      lastTop = element.scrollTop;
      setStuck(atEnd(element));
    },
    release: () => setStuck(false),
  };
};
