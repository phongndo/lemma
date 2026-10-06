/*
 * Where the reader is in a chat, by its prompts: which one they are reading,
 * which are in view, and where stepping to the previous or next one goes;
 * and the prompt rail's ticks. Pure, so the chat only measures and scrolls.
 */

/** A jump to a turn stops this far above its start. */
export const JUMP_MARGIN = 8;
/** A tick's length by how far it is from the one pointed at, then the length of the rest. */
const TICK_SCALES = [1, 0.667, 0.417];
const TICK_SCALE_REST = 0.333;

export interface Scrolled {
  /** The scroll position, and the view's and the content's heights. */
  readonly top: number;
  readonly height: number;
  readonly scrollHeight: number;
}

export interface Located {
  /** The prompt being read. */
  readonly current: number;
  /** The first and last prompts whose turns are in view. */
  readonly seen: { readonly first: number; readonly last: number } | undefined;
  /** Where the previous and next steps go. */
  readonly previous: number | undefined;
  readonly next: number | undefined;
}

/**
 * Locates the reader among prompts whose turns start at `tops` (undefined for
 * one not drawn): a turn runs to the next prompt's, the last to the end. The
 * one being read is the last whose turn starts above the top third of the
 * view, or the last one at the bottom; stepping goes to the nearest turns
 * starting above and below where the view is, or is `heading` in a jump.
 */
export function locate(tops: readonly (number | undefined)[], view: Scrolled, heading?: number): Located {
  const bottom = view.top + view.height;
  const line = view.top + view.height / 3;
  const from = heading ?? view.top;
  const atEnd = from >= view.scrollHeight - view.height - 1;
  let found: number | undefined;
  let first: number | undefined;
  let last: number | undefined;
  let previous: number | undefined;
  let next: number | undefined;
  let end = view.scrollHeight;
  for (let index = tops.length - 1; index >= 0; index--) {
    const start = tops[index];
    if (start === undefined) continue;
    if (start < bottom && end > view.top) {
      first = index;
      last ??= index;
    }
    if (found === undefined && start <= line) found = index;
    const target = Math.max(0, start - JUMP_MARGIN);
    if (previous === undefined && target < from - 1) previous = index;
    if (!atEnd && target > from + 1) next = index;
    end = start;
  }
  return {
    // At the bottom the last prompt is the one being read, however short its turn.
    current: view.scrollHeight - bottom < 2 ? Math.max(0, tops.length - 1) : (found ?? 0),
    seen: first === undefined || last === undefined ? undefined : { first, last },
    previous,
    next,
  };
}

/** A jump to `heading` is over once the view gets there, passes it, or turns away from it (it was at `lastTop`, now `top`). */
export const jumpOver = (heading: number, top: number, lastTop: number): boolean => {
  const left = heading - top;
  const before = heading - lastTop;
  return Math.abs(left) < 2 || Math.sign(left) !== Math.sign(before) || Math.abs(left) > Math.abs(before);
};

/** Where tick `index` of `count` sits along the rail, in percent: evenly spaced, top to bottom. */
export const tickAt = (index: number, count: number): number => (count < 2 ? 0 : (index / (count - 1)) * 100);

/** A tick's length: longest at the one pointed at, shorter by distance, then all alike. */
export const tickScale = (index: number, pointed: number | undefined): number =>
  pointed === undefined ? TICK_SCALE_REST : (TICK_SCALES[Math.abs(index - pointed)] ?? TICK_SCALE_REST);

/** The tick nearest `progress` (0 at the rail's top, 1 at its bottom) of `count`. */
export const tickNear = (progress: number, count: number): number => Math.round(Math.max(0, Math.min(1, progress)) * (count - 1));

/** The top of a card `height` tall, level with a tick at `tick` unless that takes it out of a view from `top` to `bottom`, `inset` inside. */
export const cardTop = (tick: number, height: number, view: { readonly top: number; readonly bottom: number }, inset: number): number =>
  Math.max(view.top + inset, Math.min(tick - height / 2, view.bottom - height - inset));
