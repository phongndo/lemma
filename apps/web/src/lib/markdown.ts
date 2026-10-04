import DOMPurify from "dompurify";
import { Marked } from "marked";
import type { Token, Tokens, TokensList } from "marked";

/** Marks where a block's nested code goes (`codePlaces`); a random name, so model HTML cannot claim one. */
const PLACE = `data-code-${Math.random().toString(36).slice(2, 10)}`;
/** Set while an HTML block with nested code renders: its code becomes places, numbered in order. */
let placing: { next: number } | undefined;

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({ renderer: { code: () => (placing === undefined ? false : `<pre ${PLACE}="${placing.next++}"></pre>`) } });

let hooked = false;
const hook = () => {
  if (hooked) return;
  hooked = true;
  // No network fetches from model output (images are forbidden below); links open outside the app
  // and cannot reach back into it.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
};

const sanitize = (html: string): string => {
  hook();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style", "class", "id"],
  });
};

/**
 * Model markdown to sanitized HTML. Raw HTML in the source is sanitized, never
 * trusted. Styling attributes are dropped too: with `style`, `class`, or `id`
 * model output could position itself over the app or borrow the app's own
 * classes to fake a dialog or toast.
 */
export const renderMarkdown = (source: string): string => sanitize(marked.parse(source) as string);

/** Tokens that stand apart from what follows them: their text is followed by a space. */
const SEPARATE = new Set(["paragraph", "heading", "code", "blockquote", "list_item", "table", "hr", "space", "br"]);

/**
 * Markdown as the text a reader sees, on one line, for a preview: emphasis,
 * link targets, and HTML are left out; code, link labels, and an ordered
 * list's numbers are kept.
 */
export const markdownText = (source: string): string => {
  let text = "";
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "list") {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          if (list.ordered) text += `${(Number(list.start) || 1) + index}. `;
          walk([item]);
        });
      } else if (token.type === "table") {
        const table = token as Tokens.Table;
        for (const cell of [...table.header, ...table.rows.flat()]) walk([...cell.tokens, { type: "br", raw: "" }]);
      } else if (token.type === "html") continue;
      else if ("tokens" in token && token.tokens !== undefined) walk(token.tokens);
      else if (token.type === "text" || token.type === "codespan" || token.type === "code" || token.type === "escape" || token.type === "image")
        text += token.text;
      if (SEPARATE.has(token.type)) text += " ";
    }
  };
  walk(marked.lexer(source));
  return text.replace(/\s+/g, " ").trim();
};

/** A code block's source, kept out of the HTML so the view (and code renderers) get it as text. */
export interface CodeBlock {
  /** The fence's language, lowercased; "" when none. */
  readonly lang: string;
  readonly code: string;
  /** The closing fence arrived: the code will not change. */
  readonly complete: boolean;
}

export type MarkdownBlock =
  | {
      readonly kind: "html";
      /** Equal keys render equal HTML. */
      readonly key: string;
      readonly html: () => string;
      /** Fenced code inside it (in a list item or a quote), in order; `html` leaves a place for each (`codePlaces`). */
      readonly code: readonly CodeBlock[];
    }
  | ({ readonly kind: "code"; readonly key: string } & CodeBlock);

/** The places an HTML block's `html` left for its nested code, each with its index in the block's `code`. */
export const codePlaces = (root: ParentNode): (readonly [Element, number])[] =>
  [...root.querySelectorAll(`pre[${PLACE}]`)].map((place) => [place, Number(place.getAttribute(PLACE))] as const);

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Whether a code token's closing fence is in its source (an indented block has none to wait for). */
const fenceClosed = (token: Tokens.Code): boolean => {
  const open = FENCE_OPEN.exec(token.raw)?.[1];
  if (open === undefined) return true;
  const lines = token.raw.replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return false;
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1)!)?.[1];
  return close !== undefined && close[0] === open[0] && close.length >= open.length;
};

const codeOf = (token: Tokens.Code): CodeBlock => ({
  lang: (token.lang ?? "").trim().split(/\s+/)[0]!.toLowerCase(),
  code: token.text,
  complete: fenceClosed(token),
});

const toBlocks = (tokens: readonly Token[], links: TokensList["links"]): MarkdownBlock[] => {
  const definitions = Object.keys(links).length === 0 ? "" : JSON.stringify(links);
  return tokens.map((token): MarkdownBlock => {
    if (token.type === "code") {
      const code = codeOf(token as Tokens.Code);
      return { kind: "code", key: `${code.complete ? "c" : "o"}\u0000${token.raw}`, ...code };
    }
    const code: CodeBlock[] = [];
    marked.walkTokens([token], (child) => {
      if (child.type === "code") code.push(codeOf(child as Tokens.Code));
    });
    return {
      kind: "html",
      key: `${definitions}\u0000${token.raw}`,
      code,
      html: () => {
        placing = code.length === 0 ? undefined : { next: 0 };
        try {
          return sanitize(marked.parser(Object.assign([token], { links }) as TokensList));
        } finally {
          placing = undefined;
        }
      },
    };
  });
};

/** A reference-link definition: it applies to every block, so a source with one is always lexed whole. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/**
 * `source` as top-level blocks (paragraphs, lists, code blocks), each rendered
 * like `renderMarkdown`. A streaming message only grows at the end, so a view
 * that keeps the blocks whose key is unchanged re-renders just the last ones.
 * Reference-link definitions apply across blocks and are part of every key.
 */
export const markdownBlocks = (source: string): MarkdownBlock[] => {
  const tokens = marked.lexer(source);
  return toBlocks(tokens, tokens.links);
};

/**
 * `markdownBlocks` for a source that grows at the end, as a streaming message
 * does: when the new source extends the last one, only its last two blocks
 * are lexed again (appended text can continue a paragraph, turn it into a
 * heading or table, or join a list), so each update costs the tail, not the
 * whole message. Anything else lexes the whole source.
 */
export const createBlockLexer = (): ((source: string) => MarkdownBlock[]) => {
  let last: { source: string; tokens: readonly Token[]; starts: readonly number[] } | undefined;
  const lex = (source: string, from: number, kept: readonly Token[], keptStarts: readonly number[]): MarkdownBlock[] | undefined => {
    const lexed = marked.lexer(source.slice(from));
    const tokens = [...kept, ...lexed];
    const starts = [...keptStarts];
    let at = from;
    for (const token of lexed) {
      starts.push(at);
      at += token.raw.length;
    }
    // Offsets are only trustworthy when the tokens cover the source exactly; otherwise stay whole.
    if (at !== source.length) return undefined;
    last = { source, tokens, starts };
    return toBlocks(tokens, lexed.links);
  };
  return (source) => {
    const previous = last;
    last = undefined;
    if (previous !== undefined && source.startsWith(previous.source) && !DEFINITION.test(source)) {
      // Restart at the second-to-last block that is not blank space.
      let restart = previous.tokens.length;
      for (let seen = 0; restart > 0 && seen < 2;) if (previous.tokens[--restart]!.type !== "space") seen++;
      const blocks = lex(source, previous.starts[restart] ?? 0, previous.tokens.slice(0, restart), previous.starts.slice(0, restart));
      if (blocks !== undefined) return blocks;
    }
    return lex(source, 0, [], []) ?? markdownBlocks(source);
  };
};
