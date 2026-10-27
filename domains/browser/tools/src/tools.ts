import { Effect, Schema } from "effect";
import type { Context } from "effect";
import { BrowserSnapshot, BrowserTab, BrowserTarget, ConsoleMessage, EvaluateResult } from "@lemma/browser";
import type { Browser, BrowserImage } from "@lemma/browser";
import { MAX_IMAGE_BYTES } from "@lemma/llm";
import { ImageBlock, ToolResult } from "@lemma/tools";
import type { Tool, ToolNamespace } from "@lemma/tools";
import { inlineLocalImages } from "@lemma/tools/files";
import { HTML_MAX_CHARS, HTML_TALL_PAGE, htmlBootstrap, htmlTheme, htmlThemeCss, withHtmlBootstrap } from "@lemma/tools/html";

type Service = Context.Service.Shape<typeof Browser>;

/** What scripts read of the `browser` tools at once, with `describeNamespace("browser")`. */
export const browserNamespace: ToolNamespace = {
  name: "browser",
  description: "A web browser the agent drives: open pages, read them as accessibility trees, click, type, and take screenshots",
  instructions: `Each session has tabs of its own (t1, t2), with their own cookies; a call that names no tabId acts on the current tab (the one opened or named last).
1. browser_open({ url }) opens a page (a new tab when none is open).
2. browser_snapshot() reads it: an accessibility tree whose elements carry refs like [ref=s3-e12].
3. Act by ref: browser_click({ ref: "s3-e12" }), browser_type({ ref, text, submit: true }), browser_select({ ref, values }). A ref is good until the next snapshot or a navigation; a stale one fails, and the fix is a new snapshot.
Without a fresh snapshot, target with a Playwright locator ("role=button[name='Save']", "text=Sign in", "label=Email") or a CSS selector; use x and y only for what has no element (a canvas).
Actions wait for their target and resolve to the current tab afterwards ({ tabId, url, title }), so a click that navigated, or opened a tab, says where it went.
browser_wait_for waits for text, a load state, or an element to show or go. browser_evaluate runs an expression in the page and resolves to its JSON value.
browser_screenshot resolves to an image block: show it with image(shot), or ask an image classifier about it (models.classify with images: [shot]) without the model seeing it.
In a script, loop: snapshot, decide (in code, or with a classifier), act, and return only what the model needs.`,
};

const TabId = Schema.optional(Schema.String.annotate({ description: "The tab to act in (t1, t2); the current tab when left out" }));
const Target = BrowserTarget.fields;
const Timeout = Schema.optional(
  Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })).annotate({ description: "Milliseconds to wait, up to 60000 (default 15000)" }),
);

/** A tab as the model reads it. */
const tabLine = (tab: BrowserTab) =>
  `${tab.tabId} · ${tab.title || "(no title)"} — ${tab.url}${tab.status !== undefined && tab.status >= 400 ? ` (HTTP ${tab.status})` : ""}`;

const result = (text: string, structured: unknown, images: readonly BrowserImage[] = []) =>
  new ToolResult({
    content: [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))],
    structured,
  });

/** What `target` names, in the words of a result. */
const named = (target: BrowserTarget) =>
  target.ref ?? target.locator ?? target.selector ?? (target.x === undefined ? "the page" : `(${target.x}, ${target.y})`);

/** An action's result: what it did, and the current tab after it. */
const acted = (did: string) => (tab: BrowserTab) => result(`${did}. Current tab: ${tabLine(tab)}`, tab);

const common = { nested: true, namespace: "browser" } as const;

const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4);

/** The `browser_*` tools, over `browser`. */
export const browserTools = (browser: Service): readonly Tool[] => [
  {
    ...common,
    name: "browser_open",
    description:
      "Open a page in the browser: in tab tabId, a new tab with newTab (or when none is open), else the current tab. Resolves to the tab. Read it next with browser_snapshot.",
    input: Schema.Struct({
      url: Schema.optional(Schema.String.annotate({ description: "The address to load; leave out to keep the tab as it is (a new tab is blank)" })),
      tabId: TabId,
      newTab: Schema.optional(Schema.Boolean.annotate({ description: "Open a new tab even when one is open" })),
    }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.open(sessionId, input), (tab) => result(`Opened ${tabLine(tab)}`, tab)),
  },
  {
    ...common,
    name: "browser_navigate",
    description: "Load an address in a tab (the current one by default), waiting for the page's load event or waitUntil. Resolves to the tab.",
    input: Schema.Struct({
      url: Schema.String.annotate({ description: "The address to load" }),
      tabId: TabId,
      waitUntil: Schema.optional(Schema.Literals(["load", "domcontentloaded", "networkidle"])),
    }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.navigate(sessionId, input), (tab) => result(`Loaded ${tabLine(tab)}`, tab)),
  },
  {
    ...common,
    name: "browser_snapshot",
    description:
      'Read a tab as an accessibility tree (YAML lines like `- button "Save" [ref=s3-e12]`), with what the page logged since the last snapshot. Its refs replace the tab\'s earlier ones and stay good until a navigation. Password values are hidden; the tree is cut near 20 KB.',
    input: Schema.Struct({ tabId: TabId }),
    output: BrowserSnapshot,
    replay: "safe",
    execute: (input, { sessionId }) =>
      Effect.map(browser.snapshot(sessionId, input), (snapshot) => {
        const console = snapshot.console.map((message) => `[${message.level}] ${message.text}`).join("\n");
        return result(
          `${snapshot.tabId} · ${snapshot.title || "(no title)"}\nURL: ${snapshot.url}\nSnapshot ${snapshot.generation}: refs s${snapshot.generation}-…, good until the next snapshot or a navigation\n\n${snapshot.tree}${console === "" ? "" : `\n\nConsole since the last snapshot:\n${console}`}`,
          snapshot,
        );
      }),
  },
  {
    ...common,
    name: "browser_click",
    description:
      "Click an element: a ref from the latest snapshot, a locator, a selector, or x and y. Waits for it to be visible and enabled. Resolves to the current tab afterwards.",
    input: Schema.Struct({
      ...Target,
      tabId: TabId,
      button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
      clickCount: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({ description: "2 for a double click" })),
    }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.click(sessionId, input), acted(`Clicked ${named(input)}`)),
  },
  {
    ...common,
    name: "browser_type",
    description: "Replace a field's text (at a point: click there and type), then press Enter with submit. Resolves to the current tab afterwards.",
    input: Schema.Struct({
      ...Target,
      tabId: TabId,
      text: Schema.String.annotate({ description: "The text the field holds afterwards" }),
      submit: Schema.optional(Schema.Boolean.annotate({ description: "Press Enter after typing" })),
    }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.type(sessionId, input), acted(`Typed into ${named(input)}`)),
  },
  {
    ...common,
    name: "browser_press",
    description: "Press a key or chord (Enter, Escape, Tab, Control+A) on an element, or on the page without a target. Resolves to the current tab.",
    input: Schema.Struct({ ...Target, tabId: TabId, key: Schema.String.annotate({ description: "A key name as Playwright knows it" }) }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.press(sessionId, input), acted(`Pressed ${input.key}`)),
  },
  {
    ...common,
    name: "browser_hover",
    description: "Move the pointer over an element or a point, to open a menu or a tooltip. Resolves to the current tab.",
    input: Schema.Struct({ ...Target, tabId: TabId }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.hover(sessionId, input), acted(`Hovered over ${named(input)}`)),
  },
  {
    ...common,
    name: "browser_select",
    description: "Pick options of a <select> by value or label. Resolves to the current tab.",
    input: Schema.Struct({ ...Target, tabId: TabId, values: Schema.Array(Schema.String).annotate({ description: "Values or labels to pick" }) }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.select(sessionId, input), acted(`Picked ${input.values.join(", ")}`)),
  },
  {
    ...common,
    name: "browser_scroll",
    description: "Scroll an element into view, or the page by deltaX/deltaY CSS pixels without a target (down most of a screen by default).",
    input: Schema.Struct({
      ...Target,
      tabId: TabId,
      deltaX: Schema.optional(Schema.Number),
      deltaY: Schema.optional(Schema.Number.annotate({ description: "Positive scrolls down" })),
    }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.scroll(sessionId, input), acted(`Scrolled ${named(input)}`)),
  },
  {
    ...common,
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression in a tab's page, awaiting a promise it gives, such as document.title or [...document.links].map((a) => a.href). Resolves to { value, truncated }: the JSON value, or the start of its JSON text past 64 KB. It may change the page.",
    input: Schema.Struct({ tabId: TabId, expression: Schema.String.annotate({ description: "A JavaScript expression" }) }),
    output: EvaluateResult,
    execute: (input, { sessionId }) =>
      Effect.map(browser.evaluate(sessionId, input), (evaluated) =>
        result(
          `${typeof evaluated.value === "string" && evaluated.truncated ? evaluated.value : JSON.stringify(evaluated.value, null, 2)}${evaluated.truncated ? "\n[Value cut at 64 KB]" : ""}`,
          evaluated,
        ),
      ),
  },
  {
    ...common,
    name: "browser_screenshot",
    description:
      "Take a screenshot of a tab's viewport, or the whole page with fullPage (up to 8000 px tall). Resolves to an image block { type, data, mimeType, note }: show it with image(), or hand it to an image classifier.",
    input: Schema.Struct({ tabId: TabId, fullPage: Schema.optional(Schema.Boolean) }),
    output: ImageBlock,
    replay: "safe",
    execute: (input, { sessionId }) =>
      Effect.map(browser.screenshot(sessionId, { ...input, maxBytes: MAX_IMAGE_BYTES }), (image) => {
        const note = `Screenshot ${image.width}×${image.height} (${image.mimeType})`;
        const block = { type: "image", data: image.data, mimeType: image.mimeType, note } satisfies ImageBlock;
        // Too large for the model even as JPEG: a script still gets it, the model reads why it has none.
        return base64Bytes(image.data) <= MAX_IMAGE_BYTES
          ? result(note, block, [image])
          : result(`${note}: too large to attach; take the viewport instead, or have a script hand it to a classifier`, block);
      }),
  },
  {
    ...common,
    name: "browser_wait_for",
    description:
      "Wait until a tab reaches a load state, text shows, or an element (ref, locator, selector) reaches a state: visible by default, hidden to wait for it to go. Resolves to the tab.",
    input: Schema.Struct({
      ...Target,
      tabId: TabId,
      text: Schema.optional(Schema.String.annotate({ description: "Text to wait for" })),
      load: Schema.optional(Schema.Literals(["load", "domcontentloaded", "networkidle"])),
      state: Schema.optional(Schema.Literals(["visible", "hidden", "attached", "detached"])),
      timeoutMs: Timeout,
    }),
    output: BrowserTab,
    execute: (input, { sessionId }) => Effect.map(browser.waitFor(sessionId, input), (tab) => result(`Done waiting. Current tab: ${tabLine(tab)}`, tab)),
  },
  {
    ...common,
    name: "browser_tabs",
    description: "List the session's tabs, the current one marked.",
    input: Schema.Struct({}),
    output: Schema.Array(BrowserTab),
    replay: "safe",
    parallel: "safe",
    execute: (_, { sessionId }) =>
      Effect.map(browser.tabs(sessionId), (tabs) =>
        result(tabs.length === 0 ? "No tabs are open" : tabs.map((tab) => `${tab.current ? "*" : " "} ${tabLine(tab)}`).join("\n"), tabs),
      ),
  },
  {
    ...common,
    name: "browser_close",
    description: "Close a tab, the current one by default. Resolves to the tabs left.",
    input: Schema.Struct({ tabId: TabId }),
    output: Schema.Array(BrowserTab),
    execute: (input, { sessionId }) =>
      Effect.map(browser.close(sessionId, input), (tabs) =>
        result(`Closed. ${tabs.length === 0 ? "No tabs are open" : `Tabs left:\n${tabs.map(tabLine).join("\n")}`}`, tabs),
      ),
  },
];

export const HtmlPreviewInput = Schema.Struct({
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(HTML_MAX_CHARS)).annotate({
    description: "A complete, self-contained HTML document",
  }),
  width: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 240, maximum: 1600 })).annotate({
      description: "Viewport width in CSS pixels, 240-1600: 728 by default, the chat's reply column; about 390 to check phones",
    }),
  ),
  appearance: Schema.optional(Schema.Literals(["dark", "light"]).annotate({ description: "The theme to draw it in; dark by default" })),
});
export type HtmlPreviewInput = typeof HtmlPreviewInput.Type;

export const HtmlPreviewOutput = Schema.Struct({
  width: Schema.Number,
  /** The height the page needs at `width`. */
  contentHeight: Schema.Number,
  capturedHeight: Schema.Number,
  console: Schema.Array(ConsoleMessage),
  /** Local images the page names that could not be inlined. */
  missingImages: Schema.Array(Schema.String),
  screenshot: ImageBlock,
});
export type HtmlPreviewOutput = typeof HtmlPreviewOutput.Type;

/** The chat's reply column, which `html_render` draws a page as wide as. */
const DEFAULT_WIDTH = 728;

/** `html_preview`: a page drawn as the chat draws it, to check before `html_render` shows it. */
export const htmlPreviewTool = (browser: Service): Tool<HtmlPreviewInput> => ({
  name: "html_preview",
  description: `Draw an HTML page in a headless browser as html_render would show it in the chat, and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output (log, info, warning, error, and uncaught exceptions with their stacks); console.log is a fine way to report checks of your own. Use it to check and fix a page before showing it with html_render, written as html_render's description says. Addresses on this machine or its network (localhost, 192.168.x.x) do not load here.`,
  input: HtmlPreviewInput,
  output: HtmlPreviewOutput,
  replay: "safe",
  parallel: "safe",
  execute: ({ html, width = DEFAULT_WIDTH, appearance = "dark" }) =>
    Effect.gen(function* () {
      const inlined = yield* Effect.promise(() => inlineLocalImages(html));
      const page = withHtmlBootstrap(inlined.html, htmlBootstrap(htmlThemeCss(htmlTheme(appearance), appearance)));
      const rendered = yield* browser.render(page, { width, colorScheme: appearance });
      const report = {
        width: rendered.width,
        contentHeight: rendered.contentHeight,
        capturedHeight: rendered.capturedHeight,
        console: rendered.console,
        missingImages: inlined.missing,
      };
      const note = `Page at ${rendered.width}px, ${appearance}: ${rendered.contentHeight}px tall${rendered.capturedHeight < rendered.contentHeight ? `, the first ${rendered.capturedHeight}px shown` : ""}`;
      // At the reply column's width or wider, where a page is no taller than in the chat: a phone's narrower width says
      // nothing of how the page reads in the chat.
      const tall =
        rendered.width >= DEFAULT_WIDTH && rendered.contentHeight > HTML_TALL_PAGE
          ? `\nTaller than the ${HTML_TALL_PAGE}px a page in the chat reads well at: shown with html_render, it is a document between your text, not a part of a reply. Keep what matters most, and split the rest into pages of their own or say it in your reply.`
          : "";
      const screenshot: ImageBlock = { type: "image", data: rendered.screenshot.data, mimeType: rendered.screenshot.mimeType, note };
      const attached = base64Bytes(rendered.screenshot.data) <= MAX_IMAGE_BYTES;
      return new ToolResult({
        content: [
          ...(attached ? [{ type: "image" as const, data: screenshot.data, mimeType: screenshot.mimeType }] : []),
          {
            type: "text",
            text: `${note}${attached ? "" : " (the screenshot is too large to attach)"}${tall}\n${JSON.stringify(report, null, 2)}`,
          },
        ],
        structured: { ...report, screenshot } satisfies HtmlPreviewOutput,
      });
    }),
});
