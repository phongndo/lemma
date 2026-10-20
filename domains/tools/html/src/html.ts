import { Schema } from "effect";
import { ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import { inlineLocalImages } from "@lemma/tools/files";
import { HTML_MAX_CHARS, HTML_TALL_PAGE, HTML_THEME_VARIABLES } from "@lemma/tools/html";

/**
 * The most a page may weigh once its images are inlined. It is logged whole with the call, and every client reading the
 * thread loads it: a page is a chart or a mockup, not an archive of screenshots.
 */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
/** The frame's height cap, in CSS pixels, when the model sets one. */
export const MIN_HEIGHT = 80;
export const MAX_HEIGHT = 2000;

export const HtmlRenderInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({ description: "A short name for the page." }),
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(HTML_MAX_CHARS)).annotate({
    description: "One complete, self-contained HTML document, with inline <style> and <script>.",
  }),
  height: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: MIN_HEIGHT, maximum: MAX_HEIGHT })).annotate({
      description: `The most the frame grows to, in CSS pixels (${MIN_HEIGHT}-${MAX_HEIGHT}); the rest of a taller page scrolls inside it, a scroll inside the chat's. Leave it out, so the frame fits the page, unless a part of the page (a long log or table) should scroll in a box of its own.`,
    }),
  ),
});
export type HtmlRenderInput = typeof HtmlRenderInput.Type;

/** What the chat draws, logged with the call. */
export interface HtmlRenderDetails {
  readonly title: string;
  /** The page as drawn: local images inlined. */
  readonly html: string;
  readonly height?: number;
  /** Absolute image paths in the page that were not inlined: missing, not an image, or too large. */
  readonly missingImages?: readonly string[];
}

/** What a script's call resolves to. */
export const HtmlRenderOutput = Schema.Struct({
  shown: Schema.Literal(true),
  title: Schema.String,
  /** Absolute image paths in the page that were not inlined. */
  missingImages: Schema.Array(Schema.String),
});
export type HtmlRenderOutput = typeof HtmlRenderOutput.Type;

const DESCRIPTION = `Show a finished HTML page (a chart, table, diagram, collage, or mockup) to the person in the chat, above your reply; call it before writing that reply. They already see the page, so the reply should not announce it, say where it is, or restate it: add only what the page does not say. When \`html_preview\` is offered, check the page with it first.
Write one self-contained document with inline <style> and <script>. Absolute paths to local images (src="/abs/shot.png", CSS url(/abs/bg.webp), or a string in a script) are inlined; remote http(s) URLs, such as a chart library from a CDN, load as they are. Scripts run, in a sandbox with no access to the app.
The page sits on the chat's own background, as wide as the reply column (narrower on phones), its left edge in line with your text. Leave html, body, and the outermost element without a background color, horizontal padding, an outer card, border, or banner title: the page is part of your reply. A box that needs a background of its own (a mock of a screen) gets at least 16px of padding on every side and var(--radius) corners. Use a fluid width; give charts fixed pixel heights; let the content set the page's height, never 100vh or height:100% on html or body.
A page is part of a reply in a chat, read between your text: keep each to one idea, within ${HTML_TALL_PAGE}px tall at the column's width (\`html_preview\` reports its contentHeight); show several things as several pages, or say the rest in your reply. The person can open any page full screen, or in a pane beside the chat, where a longer page scrolls on its own; links to places in the page (#id) scroll to them.
The page reads the app's theme as CSS custom properties on :root, following its light or dark scheme live: ${HTML_THEME_VARIABLES.map((name) => `\`${name}\``).join(", ")} (\`--chart-1\`…\`--chart-6\` are categorical colors for series). The base stylesheet sets the page's text color and font from them and its body margin to 0; your CSS overrides it.`;

/** `bytes` as a size a person reads. */
const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * The `html_render` tool: the page is kept in its result's details, which the chat draws (the web half's `display`), so
 * the thread's log holds what the person saw. It only records: run again, it records the same page.
 */
export const htmlRenderTool: Tool<HtmlRenderInput> = {
  name: "html_render",
  description: DESCRIPTION,
  input: HtmlRenderInput,
  output: HtmlRenderOutput,
  display: true,
  replay: "safe",
  parallel: "safe",
  execute: async ({ title, html, height }) => {
    const prepared = await inlineLocalImages(html);
    const bytes = Buffer.byteLength(prepared.html, "utf8");
    if (bytes > MAX_PAGE_BYTES) {
      throw new Error(
        `The page is ${size(bytes)} with its images inlined, over the ${size(MAX_PAGE_BYTES)} a page may be: use fewer or smaller images (scale screenshots down first).`,
      );
    }
    const missing = prepared.missing;
    const details: HtmlRenderDetails = {
      title,
      html: prepared.html,
      ...(height === undefined ? {} : { height }),
      ...(missing.length === 0 ? {} : { missingImages: missing }),
    };
    const note =
      missing.length === 0 ? "" : `\nThese images were not inlined (missing, not an image, or too large), so the page shows them broken: ${missing.join(", ")}`;
    return new ToolResult({
      content: [
        {
          type: "text",
          text: `Shown to the person as "${title}", above your reply. Do not describe or restate the page; reply with only what it does not say.${note}`,
        },
      ],
      details,
      structured: { shown: true, title, missingImages: [...missing] } satisfies HtmlRenderOutput,
    });
  },
};
