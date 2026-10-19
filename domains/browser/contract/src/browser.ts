import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";

/**
 * What an action acts on, exactly one of: a `ref` from the tab's latest snapshot (`s3-e12`), a Playwright `locator`
 * (`role=button[name='Save']`, `text=Sign in`), a CSS `selector`, or a point, `x` and `y` together, in CSS pixels from
 * the viewport's top left.
 */
export const BrowserTarget = Schema.Struct({
  ref: Schema.optional(Schema.String.annotate({ description: "A ref from the latest snapshot of the tab, such as s3-e12" })),
  locator: Schema.optional(Schema.String.annotate({ description: "A Playwright selector: role=button[name='Save'], text=Sign in, or label=Email" })),
  selector: Schema.optional(Schema.String.annotate({ description: "A CSS selector, such as button[type=submit]" })),
  x: Schema.optional(Schema.Number.annotate({ description: "Viewport X in CSS pixels, with y" })),
  y: Schema.optional(Schema.Number.annotate({ description: "Viewport Y in CSS pixels, with x" })),
});
export type BrowserTarget = typeof BrowserTarget.Type;

/** Why `target` names no single thing to act on, or undefined when it names exactly one. */
export const targetProblem = (target: BrowserTarget): string | undefined => {
  const point = target.x !== undefined || target.y !== undefined;
  if (point && (target.x === undefined || target.y === undefined)) return "x and y go together: give both, or a ref, locator, or selector instead";
  const given = [target.ref, target.locator, target.selector].filter((value) => value !== undefined).length + (point ? 1 : 0);
  if (given === 0) return "Name what to act on: a ref from browser_snapshot, a locator, a selector, or x and y";
  if (given > 1) return "Name one thing to act on: a ref, a locator, a selector, or x and y, not several";
  return undefined;
};

/** Whether `target` names anything; an action whose target is optional (`press`, `scroll`) acts on the page without one. */
export const hasTarget = (target: BrowserTarget): boolean =>
  target.ref !== undefined || target.locator !== undefined || target.selector !== undefined || target.x !== undefined || target.y !== undefined;

/** A ref as a snapshot gives it: its snapshot's generation and the element's id in that snapshot (`s3-e12`). */
export const formatRef = (generation: number, element: string): string => `s${generation}-${element}`;

/** A ref's generation and element id, or undefined when it is not one a snapshot gave. */
export const parseRef = (ref: string): { readonly generation: number; readonly element: string } | undefined => {
  const match = /^s(\d+)-([a-z]\d+(?:[a-z]\d+)*)$/i.exec(ref.trim());
  return match === null ? undefined : { generation: Number(match[1]), element: match[2]! };
};

/** A tab, and what it shows now. */
export const BrowserTab = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  /** The session's current tab: the one a call that names none acts on. */
  current: Schema.Boolean,
  /** The HTTP status the page came with, from `open` and `navigate`: a 404 page loads as any other does. */
  status: Schema.optional(Schema.Number),
});
export type BrowserTab = typeof BrowserTab.Type;

export const ConsoleLevel = Schema.Literals(["log", "info", "warning", "error", "debug"]);
export type ConsoleLevel = typeof ConsoleLevel.Type;

/** A console message a page logged, or an uncaught exception (`error`, with its stack). */
export const ConsoleMessage = Schema.Struct({ level: ConsoleLevel, text: Schema.String });
export type ConsoleMessage = typeof ConsoleMessage.Type;

/** What a tab shows, as an accessibility tree with a ref on each element an action can target. */
export const BrowserSnapshot = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  /** The snapshot's number in its tab: its refs (`s<generation>-e12`) stay good until the next one or a navigation. */
  generation: Schema.Number,
  /** The tree, as YAML lines (`- button "Save" [ref=s3-e12]`), password values hidden. */
  tree: Schema.String,
  /** The tree was cut to its first part; the rest is read with `evaluate`. */
  truncated: Schema.Boolean,
  /** What the tab logged since the last snapshot, its newest messages. */
  console: Schema.Array(ConsoleMessage),
});
export type BrowserSnapshot = typeof BrowserSnapshot.Type;

/** A screenshot, base64. */
export const BrowserImage = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type BrowserImage = typeof BrowserImage.Type;

/** An expression's value, as JSON; a long one is cut and given as the start of its JSON text. */
export const EvaluateResult = Schema.Struct({ value: Schema.Unknown, truncated: Schema.Boolean });
export type EvaluateResult = typeof EvaluateResult.Type;

/** A page `render` drew: a screenshot of its content, how tall the content is, and what it logged. */
export const RenderedPage = Schema.Struct({
  width: Schema.Number,
  /** The height the content needs at `width`, in CSS pixels. */
  contentHeight: Schema.Number,
  /** How much of it the screenshot shows: the content height, up to a cap. */
  capturedHeight: Schema.Number,
  screenshot: BrowserImage,
  console: Schema.Array(ConsoleMessage),
});
export type RenderedPage = typeof RenderedPage.Type;

export type LoadState = "load" | "domcontentloaded" | "networkidle";

export class BrowserError extends Data.TaggedError("BrowserError")<{
  /**
   * `Unavailable`: no browser could be started (none found, or it failed to launch). `NoTab`: the session has no such
   * tab. `StaleRef`: a ref from an earlier snapshot, or from before a navigation. `InvalidTarget`: a target naming
   * nothing, several things, or something not on the page. `Timeout`: waited too long. `Failed`: anything else.
   */
  readonly reason: "Unavailable" | "NoTab" | "StaleRef" | "InvalidTarget" | "Timeout" | "Failed";
  /** What happened and what to do next, for the model to read. */
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Where a call acts: the session's tab `tabId`, or its current one. */
export interface InTab {
  readonly tabId?: string | undefined;
}

/**
 * A browser the agent drives: each session has tabs of its own (`t1`, `t2`), in a profile of its own, so one session's
 * cookies are not another's. A call that names no tab acts on the session's current tab: the one it opened or named
 * last. Actions wait for their target to be ready, up to a timeout, and resolve to the tab as it is afterwards, so a
 * click that navigated says where it went. `render` draws a page on its own, outside any session, for checking it.
 */
export class Browser extends Context.Service<
  Browser,
  {
    /**
     * Opens a page: in tab `tabId` (which becomes current), a new tab with `newTab` or when the session has none, else
     * the current tab; at `url`, or as it is (a new tab is blank).
     */
    readonly open: (
      sessionId: string,
      options: InTab & { readonly url?: string | undefined; readonly newTab?: boolean | undefined },
    ) => Effect.Effect<BrowserTab, BrowserError>;
    readonly tabs: (sessionId: string) => Effect.Effect<readonly BrowserTab[]>;
    /** Closes a tab, the current one by default, and gives the tabs left. */
    readonly close: (sessionId: string, options: InTab) => Effect.Effect<readonly BrowserTab[], BrowserError>;
    readonly navigate: (
      sessionId: string,
      options: InTab & { readonly url: string; readonly waitUntil?: LoadState | undefined },
    ) => Effect.Effect<BrowserTab, BrowserError>;
    /** A new snapshot, whose refs replace the tab's earlier ones. */
    readonly snapshot: (sessionId: string, options: InTab) => Effect.Effect<BrowserSnapshot, BrowserError>;
    readonly click: (
      sessionId: string,
      options: InTab & BrowserTarget & { readonly button?: "left" | "right" | "middle" | undefined; readonly clickCount?: number | undefined },
    ) => Effect.Effect<BrowserTab, BrowserError>;
    /** Replaces a field's text (at a point: clicks there and types), and presses Enter after it with `submit`. */
    readonly type: (
      sessionId: string,
      options: InTab & BrowserTarget & { readonly text: string; readonly submit?: boolean | undefined },
    ) => Effect.Effect<BrowserTab, BrowserError>;
    /** Presses a key or chord (`Enter`, `Control+A`) on the target, or on the page without one. */
    readonly press: (sessionId: string, options: InTab & BrowserTarget & { readonly key: string }) => Effect.Effect<BrowserTab, BrowserError>;
    readonly hover: (sessionId: string, options: InTab & BrowserTarget) => Effect.Effect<BrowserTab, BrowserError>;
    /** Picks options of a `<select>` by value or label. */
    readonly select: (sessionId: string, options: InTab & BrowserTarget & { readonly values: readonly string[] }) => Effect.Effect<BrowserTab, BrowserError>;
    /** Scrolls the target into view, or the page by a distance in CSS pixels without one. */
    readonly scroll: (
      sessionId: string,
      options: InTab & BrowserTarget & { readonly deltaX?: number | undefined; readonly deltaY?: number | undefined },
    ) => Effect.Effect<BrowserTab, BrowserError>;
    /** Evaluates a JavaScript expression in the tab's main frame, awaiting a promise it gives. */
    readonly evaluate: (sessionId: string, options: InTab & { readonly expression: string }) => Effect.Effect<EvaluateResult, BrowserError>;
    /** The viewport, or the whole page (up to a cap), as PNG; as JPEG when a PNG would pass `maxBytes`. */
    readonly screenshot: (
      sessionId: string,
      options: InTab & { readonly fullPage?: boolean | undefined; readonly maxBytes?: number | undefined },
    ) => Effect.Effect<BrowserImage, BrowserError>;
    /**
     * Waits until the page reaches a load state, `text` shows, or the target reaches `state` (`visible` by default;
     * `hidden` to wait for it to go), up to `timeoutMs`.
     */
    readonly waitFor: (
      sessionId: string,
      options: InTab &
        BrowserTarget & {
          readonly text?: string | undefined;
          readonly load?: LoadState | undefined;
          readonly state?: "visible" | "hidden" | "attached" | "detached" | undefined;
          readonly timeoutMs?: number | undefined;
        },
    ) => Effect.Effect<BrowserTab, BrowserError>;
    /**
     * Draws `html`, a whole document, at `width` CSS pixels, in a page of its own with the color scheme `colorScheme`:
     * remote resources it names load, and the screenshot shows its content, up to a cap.
     */
    readonly render: (html: string, options: { readonly width: number; readonly colorScheme: "dark" | "light" }) => Effect.Effect<RenderedPage, BrowserError>;
  }
>()("lemma/Browser") {}
