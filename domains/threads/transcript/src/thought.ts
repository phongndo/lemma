/**
 * How a thought reads collapsed to one line. Reasoning summaries (OpenAI's
 * among them) open each section with a bold or heading line, `**Checking the
 * tests**`: those are the thought's titles. Pure, and linear in the text: it
 * runs on every streamed update, so no pattern here may backtrack.
 */

/** Longer lines are no title, and are cut to this before their markdown is read: one line shows, ellipsized. */
const LINE = 300;

/** A title without the colon it may end with, inside its marks or out; undefined when nothing is left. */
const bare = (title: string): string | undefined => {
  const trimmed = title.trim();
  const text = trimmed.endsWith(":") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  return text === "" ? undefined : text;
};

/** The title a line holds: `# Title`, `**Title**`, or `__Title__`, a trailing colon allowed; undefined for any other line. */
const titleOf = (raw: string): string | undefined => {
  let line = raw.trim();
  if (line.length > LINE) return undefined;
  if (line.endsWith(":")) line = line.slice(0, -1).trimEnd();
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level >= 1 && level <= 6 && (line[level] === " " || line[level] === "\t")) {
    let end = line.length;
    while (end > level && line[end - 1] === "#") end--;
    return bare(line.slice(level, end));
  }
  for (const mark of ["**", "__"]) {
    if (line.length > 4 && line.startsWith(mark) && line.endsWith(mark)) {
      const inner = line.slice(2, -2);
      // `**a** and **b**` is a sentence with two bold words, not a title.
      return inner.includes(mark) ? undefined : bare(inner);
    }
  }
  return undefined;
};

/** The titles a thought's sections open with, in order, as plain text. */
export const thoughtTitles = (text: string): string[] =>
  text.split("\n").flatMap((line) => {
    const title = titleOf(line);
    return title === undefined ? [] : [plainText(title)];
  });

/** A line of markdown as the text it reads as: no emphasis, code ticks, link targets, or block markers. Cut to a line's worth first. */
export const plainText = (line: string): string =>
  line
    .slice(0, LINE)
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    // Emphasis still being written: its closing marks have not streamed yet.
    .replace(/^(\*\*|__)(?=\S)/, "")
    .trim();

/**
 * One line for a collapsed thought: its title (the first, or while it is still
 * being written, the latest), else its first line (its latest while live), as
 * plain text.
 */
export const thoughtHeadline = (text: string, live = false): string => {
  const titles = thoughtTitles(text);
  if (titles.length > 0) return (live ? titles.at(-1) : titles[0])!;
  const lines = text.split("\n").filter((candidate) => candidate.trim() !== "");
  const line = live ? lines.at(-1) : lines[0];
  return line === undefined ? "" : plainText(line);
};
