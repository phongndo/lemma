/** What the web half reads of a call and of a page, apart from drawing: pure, so it is tested without a page. */

/** A call's page as its result's details hold it, or undefined for a result that holds none (an error). */
export interface RenderedPage {
  readonly title: string;
  readonly html: string;
  readonly height?: number;
  readonly missingImages: readonly string[];
}

export const pageOf = (details: unknown): RenderedPage | undefined => {
  const value = details as { title?: unknown; html?: unknown; height?: unknown; missingImages?: unknown } | null | undefined;
  if (typeof value?.title !== "string" || typeof value.html !== "string") return undefined;
  const missing = Array.isArray(value.missingImages) ? value.missingImages.filter((path): path is string => typeof path === "string") : [];
  return {
    title: value.title,
    html: value.html,
    ...(typeof value.height === "number" && Number.isFinite(value.height) ? { height: value.height } : {}),
    missingImages: missing,
  };
};

/** A link a page may hand the app to open: on the web or an email, never a script or a data URL. */
export const openable = (href: unknown): href is string => typeof href === "string" && /^(https?:|mailto:)/i.test(href);

/** The frame's height before the page first says its own. */
export const INITIAL_HEIGHT = 160;
/**
 * The most a frame grows to with no cap of the model's: a page sized by its frame (100vh) would otherwise grow with
 * every height it reports.
 */
export const AUTO_MAX_HEIGHT = 4000;
/** A report this soon after the frame's height changed is the page's answer to that change. */
const ANSWER_MS = 120;
/** Answers in a row that overflow the frame by the same amount before the frame stops growing with them. */
const FOLLOWING = 3;
/** How long a smaller height must stand, with no larger one, before the frame shrinks to it. */
export const SHRINK_MS = 150;

/**
 * The height of a page's frame, as the page reports its own: up to `cap` when the model set one (the rest scrolls
 * inside), else up to `AUTO_MAX_HEIGHT`.
 *
 * - A report under 1 is a page not laid out (its body not parsed yet, or its frame hidden) and changes nothing: taken
 *   as a height, the frame would shrink to nothing.
 * - The frame grows at once and shrinks only once a smaller height has stood for `SHRINK_MS` (`settle`): a frame's new
 *   size reaches its page a little late, so a page sized by its frame reports heights that go up and down by turns as
 *   it settles, and following each would shake the frame for ever.
 * - A page that answers each growth of its frame with one that much larger again (`min-height: 100vh` and a margin)
 *   is sized by its frame: after it has done so three times running, the frame keeps its height, the rest scrolling
 *   inside, until the page reports a height it fits in.
 */
export const frameHeight = (cap?: number) => {
  const max = cap ?? AUTO_MAX_HEIGHT;
  let height = Math.min(cap ?? INITIAL_HEIGHT, max);
  let changedAt = Number.NEGATIVE_INFINITY;
  let gap: number | undefined;
  let following = 0;
  let held = false;
  let smaller: { readonly height: number; readonly since: number } | undefined;
  const change = (next: number, now: number) => {
    if (next === height) return;
    height = next;
    changedAt = now;
  };
  return {
    get height() {
      return height;
    },
    /** Whether a smaller height waits to stand: call `settle` once `SHRINK_MS` has passed. */
    get shrinking() {
      return smaller !== undefined;
    },
    /** The frame's height once the page reports `reported` at `now` (ms). */
    report: (reported: number, now: number): number => {
      if (!Number.isFinite(reported) || reported < 1) return height;
      const wanted = Math.min(Math.ceil(reported), max);
      if (wanted < height) {
        if (smaller === undefined || wanted !== smaller.height) smaller = { height: wanted, since: smaller?.since ?? now };
        return height;
      }
      smaller = undefined;
      if (wanted === height) return height;
      const over = wanted - height;
      following = now - changedAt <= ANSWER_MS && over === gap ? following + 1 : 1;
      gap = over;
      if (following >= FOLLOWING) held = true;
      if (!held) change(wanted, now);
      return height;
    },
    /** The frame's height at `now`: a smaller height that has stood for `SHRINK_MS` taken. */
    settle: (now: number): number => {
      if (smaller !== undefined && now - smaller.since >= SHRINK_MS) {
        change(smaller.height, now);
        smaller = undefined;
        following = 0;
        gap = undefined;
        held = false;
      }
      return height;
    },
  };
};
