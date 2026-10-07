/** What ends a word outside brackets: whitespace, quotes, and the markup and code around a class. */
const BREAK = /[\s"'`<>{};,=]/;

/**
 * Each word with a bracketed arbitrary value or selector, read whole: inside
 * brackets, which nest, anything but whitespace belongs to it, quotes
 * included (`tw:font-['Inter']`, `tw:[&>p]:mt-2`,
 * `tw:[&[data-state='open']]:bg-accent`). A word whose brackets do not close
 * before whitespace is no class.
 */
const bracketed = (source: string): string[] => {
  const words: string[] = [];
  let word = "";
  let depth = 0;
  const end = () => {
    if (depth === 0 && word.includes("[")) words.push(word);
    word = "";
    depth = 0;
  };
  for (const char of source) {
    if (/\s/.test(char) || (depth === 0 && BREAK.test(char))) {
      end();
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]" && depth > 0) depth--;
    word += char;
  }
  end();
  return words;
};

/**
 * The words in a UI file's source that could be Tailwind classes, as the
 * build's scanner finds them in the app's own: what lies between quotes,
 * backticks, and whitespace, with the markup around a class in an `html`
 * template trimmed off, and each class with brackets whole, quotes inside
 * them included. A class must appear whole, so `bg-${color}` names no
 * utility. Words that are no class cost nothing: Tailwind ignores them.
 */
export const extractCandidates = (source: string): string[] => {
  const found = new Set<string>();
  const add = (word: string) => {
    const candidate = word.replace(/^[<>{}(;,=]+/, "").replace(/[<>{};,=]+$/, "");
    if (candidate !== "" && candidate.length <= 200 && /[a-z]/.test(candidate)) found.add(candidate);
  };
  for (const word of source.split(/[\s"'`]+/)) add(word);
  for (const word of bracketed(source)) add(word);
  return [...found];
};
