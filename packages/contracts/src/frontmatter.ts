/*
 * A Markdown file's frontmatter, as skills and modes write it: `@lemma/contracts/frontmatter`. Pure, so a web half can
 * read it too.
 */

/**
 * `value` without its quotes, when it is one quoted scalar: `"…"` (`\"` and `\\` escaped) or `'…'` (`''` for a quote).
 * Anything else, a list of quoted items (`"a", "b"`) say, is returned as it is.
 */
export const unquote = (value: string): string => {
  const double = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(value);
  if (double !== null) return double[1]!.replace(/\\(["\\])/g, "$1");
  const single = /^'((?:[^']|'')*)'$/.exec(value);
  return single === null ? value : single[1]!.replace(/''/g, "'");
};

/**
 * A Markdown file's frontmatter fields and body; a file with none is all body. The frontmatter is read as flat YAML:
 * `key: value`, a value quoted or not (`unquote`), continued on indented lines, or a block (`>` folded, `|` literal) on
 * the indented lines after it.
 */
export const parseFrontmatter = (text: string): { readonly fields: Readonly<Record<string, string>>; readonly body: string } => {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (block === null) return { fields: {}, body: source.trim() };
  const fields: Record<string, string> = {};
  const lines = block[1]!.split(/\r?\n/);
  for (let at = 0; at < lines.length; at++) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[at]!);
    if (field === null) continue;
    const [, key, first] = field as unknown as [string, string, string];
    const more: string[] = [];
    while (at + 1 < lines.length && (/^\s/.test(lines[at + 1]!) || lines[at + 1] === "")) more.push(lines[++at]!);
    const style = /^([>|])[+-]?$/.exec(first.trim());
    const continued = more.map((line) => line.trim());
    fields[key] =
      style === null
        ? unquote([first.trim(), ...continued].filter((part) => part !== "").join(" "))
        : style[1] === "|"
          ? continued.join("\n").trim()
          : continued.join(" ").replace(/\s+/g, " ").trim();
  }
  return { fields, body: source.slice(block[0].length).trim() };
};
