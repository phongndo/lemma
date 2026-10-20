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
/** How long a height the page asked for must stand before it is the page's own (`settled`): longer than a page takes to answer its frame's change. */
export const SETTLE_MS = 300;

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
  let reported = false;
  /** What the page last asked for, within the most: the frame fits the page when it is this tall. */
  let wanted: number | undefined;
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
    /**
     * The frame has been as tall as the page asked, with nothing waiting, for `SETTLE_MS` at `now`: a height to remember
     * (`rememberHeight`). A page sized by its frame answers each new height with a larger one, and once held asks for
     * more than the frame has, so it never settles: the height it was held at is not taken for its own, which, started
     * at, would hold the frame taller each time it is drawn.
     */
    settled: (now: number): boolean => wanted === height && smaller === undefined && !held && now - changedAt >= SETTLE_MS,
    /**
     * The frame's height before the page reports its own, from a height it was seen to take before (`recallHeight`):
     * a frame that starts as tall as its page moves nothing around it when the page loads, or when a frame out of view
     * (which reports nothing) is scrolled to. A guess after the first report changes nothing.
     */
    guess: (known: number): number => {
      if (!reported && Number.isFinite(known) && known >= 1) height = Math.min(Math.ceil(known), max);
      return height;
    },
    /** The frame's height once the page reports `reported` at `now` (ms). */
    report: (value: number, now: number): number => {
      if (!Number.isFinite(value) || value < 1) return height;
      reported = true;
      const asked = Math.min(Math.ceil(value), max);
      wanted = asked;
      if (asked < height) {
        if (smaller === undefined || asked !== smaller.height) smaller = { height: asked, since: smaller?.since ?? now };
        return height;
      }
      smaller = undefined;
      if (asked === height) return height;
      const over = asked - height;
      following = now - changedAt <= ANSWER_MS && over === gap ? following + 1 : 1;
      gap = over;
      if (following >= FOLLOWING) held = true;
      if (!held) change(asked, now);
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

/** The heights a page's frame settled at, by the width it was drawn at: its last few widths, the latest last. */
export interface RememberedPage {
  /** The page's call (`ToolBodyProps.id`). */
  readonly key: string;
  readonly sizes: readonly (readonly [width: number, height: number])[];
}

/** The pages remembered, the one seen longest ago first. */
export type RememberedHeights = readonly RememberedPage[];

/** How many pages, and widths of each, are remembered: the pages of the threads read lately. */
export const REMEMBERED_PAGES = 200;
const REMEMBERED_WIDTHS = 4;

export const isRememberedHeights = (value: unknown): value is RememberedHeights =>
  Array.isArray(value) &&
  value.every(
    (page: { key?: unknown; sizes?: unknown } | null) =>
      typeof page?.key === "string" &&
      Array.isArray(page.sizes) &&
      page.sizes.every((size: unknown) => Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === "number" && Number.isFinite(n))),
  );

/** `heights` with `key`'s frame `height` px tall at `width`: the page seen last, its oldest width and page let go past the most. */
export const rememberHeight = (heights: RememberedHeights, key: string, width: number, height: number): RememberedHeights => {
  const at = Math.round(width);
  const before = heights.find((page) => page.key === key);
  if (before?.sizes.at(-1)?.[0] === at && before.sizes.at(-1)?.[1] === height && heights.at(-1) === before) return heights;
  const sizes = [...(before?.sizes ?? []).filter(([seen]) => seen !== at), [at, height] as const].slice(-REMEMBERED_WIDTHS);
  return [...heights.filter((page) => page !== before), { key, sizes }].slice(-REMEMBERED_PAGES);
};

/** The height `key`'s frame took at `width`, else at the nearest width it was drawn at; undefined for a page never seen. */
export const recallHeight = (heights: RememberedHeights, key: string, width: number): number | undefined => {
  const sizes = heights.find((page) => page.key === key)?.sizes ?? [];
  let best: readonly [number, number] | undefined;
  for (const size of sizes) if (best === undefined || Math.abs(size[0] - width) < Math.abs(best[0] - width)) best = size;
  return best?.[1];
};

/** A height a frame took, not yet stored: its page, the width it was drawn at, and the height. */
export type HeightChange = readonly [key: string, width: number, height: number];

/**
 * `changes` laid over the heights stored now, so that what another window stored since this one last read them is
 * kept rather than overwritten.
 */
export const mergeHeights = (stored: RememberedHeights, changes: readonly HeightChange[]): RememberedHeights =>
  changes.reduce((heights, [key, width, height]) => rememberHeight(heights, key, width, height), stored);

/** Which page each of the pane's page tabs shows, by its call. */
export type PageTabs = Readonly<Record<string, string>>;

/** How many tabs' pages are kept: a tab long closed is let go, the tab named last kept longest. */
export const REMEMBERED_TABS = 100;

/** `tabs` with `tab` showing `key`, laid over what is stored now (another window's tabs kept), the oldest let go past the most. */
export const assignTab = (tabs: PageTabs, tab: string, key: string): PageTabs => {
  const { [tab]: _, ...rest } = tabs;
  return Object.fromEntries([...Object.entries(rest), [tab, key] as const].slice(-REMEMBERED_TABS));
};
