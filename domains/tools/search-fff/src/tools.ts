// The tools' descriptions, defaults, and output follow pi-fff (MIT, github.com/dmtrKovalenko/fff, packages/pi-fff),
// which fff's author tunes against agents.
import { Schema } from "effect";
import type { GrepCursor, GrepMode, Result } from "@ff-labs/fff-node";
import { keepHead, outputBudget } from "@lemma/tools";
import type { Tool, ToolResult } from "@lemma/tools";
import { text, throwIfAborted } from "@lemma/tools/files";
import type { FffIndex, FffIndexesService } from "@lemma/workspace/fff";
import { scopeOf } from "./scope.ts";

export const DEFAULT_GREP_LIMIT = 20;
export const DEFAULT_FIND_LIMIT = 30;
/** The most matches a grep returns; fff finishes the file it is in, so a page can run over. */
const GREP_LIMIT_MAX = 50;
const FIND_LIMIT_MAX = 200;
/** Matches kept from one file, apart from the page, so a file's later matches stay reachable by cursor (fff's default). */
const MATCHES_PER_FILE = 200;
const CONTEXT_MAX = 20;
const LINE_MAX = 500;
/** How long a call waits for a new index's first scan before answering from what is indexed so far. */
export const SCAN_WAIT_MS = 15_000;
/**
 * fff searches on the host's thread, which serves every client and session: a grep stops after this long, and its
 * result gives a cursor to continue from.
 */
export const GREP_TIME_BUDGET_MS = 2_000;
/** How many files a weak find shows. */
const WEAK_SAMPLE = 5;

const PATH_DESCRIPTION =
  "Where to search: a folder, a file, or a glob ('src', 'src/app.ts', '*.ts', 'src/**/*.test.ts'), relative to the working directory; an absolute or ~/ path searches outside it. A folder or file that exists matches exactly; a name that does not matches anywhere ('main.rs', 'lib/').";
const Exclude = Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
  description:
    "Paths to leave out, comma- or space-separated or a list: a folder ('test/'), a file name ('config.json'), or a glob ('*.min.js'), each matched anywhere. A leading '!' is optional.",
});
const Cursor = Schema.String.annotate({ description: "Continue from where a previous result's cursor says" });

export const GrepInput = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Text or regex to search for; a bare identifier works best" }),
  path: Schema.optional(Schema.String.annotate({ description: PATH_DESCRIPTION })),
  exclude: Schema.optional(Exclude),
  caseSensitive: Schema.optional(
    Schema.Boolean.annotate({ description: "Match case exactly; otherwise case is ignored unless the pattern has a capital letter" }),
  ),
  context: Schema.optional(Schema.Number.annotate({ description: `Lines shown before and after each match (0-${CONTEXT_MAX})` })),
  limit: Schema.optional(Schema.Number.annotate({ description: `Most matches to return (default ${DEFAULT_GREP_LIMIT}, at most ${GREP_LIMIT_MAX})` })),
  cursor: Schema.optional(Cursor),
});
export type GrepInput = typeof GrepInput.Type;

export const FindInput = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Fuzzy path query, one or two words ('composer', 'web comp'); empty lists what path holds, most recently changed first",
  }),
  path: Schema.optional(Schema.String.annotate({ description: PATH_DESCRIPTION })),
  exclude: Schema.optional(Exclude),
  limit: Schema.optional(Schema.Number.annotate({ description: `Most files to return (default ${DEFAULT_FIND_LIMIT}, at most ${FIND_LIMIT_MAX})` })),
  cursor: Schema.optional(Cursor),
});
export type FindInput = typeof FindInput.Type;

/** What a result logs for UIs: the directory searched and how many it returned. */
export interface SearchDetails {
  readonly root: string;
  readonly shown: number;
  /** A grep that matched nothing exactly and shows fuzzy matches instead. */
  readonly fuzzy?: true;
}

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)));

const unwrap = <A>(result: Result<A>): A => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** A cursor is the count it continues from, as text: it holds nothing the host keeps, so it outlives a restart. */
const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new Error(`cursor "${cursor}" is not one a previous result gave`);
  return Number(cursor);
};

/** fff's grep cursor is the offset of the next file to search; built as fff builds one (`createGrepCursor`, not exported). */
const grepCursor = (offset: number): GrepCursor => ({ __brand: "GrepCursor", _offset: offset });

/** Waits for a new index's first scan, up to `SCAN_WAIT_MS` or until the call is cancelled; true while it still runs. */
async function scanned(finder: FffIndex, signal: AbortSignal): Promise<boolean> {
  if (finder.isScanning()) {
    let stop!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      stop = resolve;
      signal.addEventListener("abort", stop, { once: true });
    });
    try {
      await Promise.race([finder.waitForScan(SCAN_WAIT_MS), cancelled]);
    } finally {
      signal.removeEventListener("abort", stop);
    }
    throwIfAborted(signal);
  }
  return finder.isScanning();
}

/** One tag at most, so a list stays scannable: a file git sees changed, else one fff's frecency ranks high (pi-fff's thresholds). */
function annotation(item: { readonly gitStatus?: string; readonly totalFrecencyScore?: number }): string {
  const git = item.gitStatus;
  if (git !== undefined && git !== "" && git !== "clean" && git !== "unknown") return `  [${git} in git]`;
  const frecency = item.totalFrecencyScore ?? 0;
  if (frecency >= 25) return "  [VERY often touched file]";
  if (frecency >= 20) return "  [often touched file]";
  return "";
}

const clip = (line: string) => {
  const trimmed = line.trim();
  return trimmed.length <= LINE_MAX ? trimmed : `${trimmed.slice(0, LINE_MAX)}...`;
};

/** The body, cut to the call's budget, then the notices in brackets. */
function finish(body: string, notices: readonly string[], details: SearchDetails, maxResultChars: number | undefined): ToolResult {
  const kept = keepHead(body, outputBudget(maxResultChars), { rest: () => "Narrow the search, or lower context or limit." });
  return text(notices.length === 0 ? kept.text : `${kept.text}\n\n[${notices.join(". ")}]`, details);
}

const INDEXING = "Still indexing: files not read yet are missing";

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
/** Regex syntax alone (`.*`, `.+`, `^$`): it would match every line. */
const WILDCARD_ONLY = /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/;

/** A regex when the pattern uses regex syntax and is one; plain text otherwise. */
const modeOf = (pattern: string): GrepMode => {
  if (!REGEX_SYNTAX.test(pattern)) return "plain";
  try {
    new RegExp(pattern);
    return "regex";
  } catch {
    return "plain";
  }
};

export const grepTool = (indexes: FffIndexesService): Tool<GrepInput> => ({
  name: "grep",
  description: `Search file contents, in the working directory or path, leaving out what .gitignore ignores. A pattern is plain text unless it is a valid regex using regex syntax; case is ignored unless the pattern has a capital letter or caseSensitive is set. When a plain pattern matches nothing, close fuzzy matches are shown instead. Files changed recently come first, and files git sees changed are tagged; matches within a file stay in order. Prefer a bare identifier as the pattern. Narrow with path ('src', '*.ts') and drop noise with exclude ('test/,*.min.js'). After one or two searches, read the best match rather than searching again. Returns up to ${DEFAULT_GREP_LIMIT} matches by default.`,
  input: GrepInput,
  // It only reads: cut off by a host restart, it runs again, and searches the model asks for together run together.
  replay: "safe",
  parallel: "safe",
  execute: async (input, { cwd, signal, maxResultChars }) => {
    throwIfAborted(signal);
    const pattern = input.pattern;
    if (pattern.trim() === "") throw new Error("The pattern is empty: give a word or identifier to search for");
    const mode = modeOf(pattern);
    if (mode === "regex" && WILDCARD_ONLY.test(pattern.trim())) {
      return text(
        `Pattern '${pattern}' matches everything: grep needs a concrete substring or identifier, such as 'MyClass' or 'export function'. To read a file, use read.`,
      );
    }
    const offset = offsetOf(input.cursor);
    const scope = await scopeOf(input.path, input.exclude, cwd);
    const limit = clamp(input.limit, DEFAULT_GREP_LIMIT, 1, GREP_LIMIT_MAX);
    const context = clamp(input.context, 0, 0, CONTEXT_MAX);
    return indexes.use(scope.root, async (finder) => {
      const indexing = await scanned(finder, signal);
      const query = [...scope.constraints, pattern].join(" ");
      const options = {
        smartCase: input.caseSensitive !== true,
        maxMatchesPerFile: MATCHES_PER_FILE,
        pageSize: limit,
        timeBudgetMs: GREP_TIME_BUDGET_MS,
        enforceTimeBudget: true,
      };
      const exact = unwrap(
        finder.grep(query, { ...options, mode, cursor: offset === 0 ? null : grepCursor(offset), beforeContext: context, afterContext: context }),
      );
      // A plain pattern found nowhere: what fuzzily matches it, without context or a cursor to continue.
      const searchedAll = exact.items.length === 0 && exact.nextCursor === null && offset === 0;
      const fuzzy = searchedAll && mode === "plain" ? finder.grep(query, { ...options, mode: "fuzzy" }) : undefined;
      const isFuzzy = fuzzy?.ok === true && fuzzy.value.items.length > 0;
      const result = isFuzzy ? fuzzy.value : exact;

      const lines: string[] = [];
      let file: string | undefined;
      for (const match of result.items) {
        if (match.relativePath !== file) {
          if (lines.length > 0) lines.push("");
          file = match.relativePath;
          lines.push(`${scope.display(file)}${annotation(match)}`);
        }
        const before = match.contextBefore ?? [];
        before.forEach((line, i) => lines.push(` ${match.lineNumber - before.length + i}- ${clip(line)}`));
        lines.push(` ${match.lineNumber}: ${clip(match.lineContent)}`);
        (match.contextAfter ?? []).forEach((line, i) => lines.push(` ${match.lineNumber + 1 + i}- ${clip(line)}`));
      }

      const notices: string[] = [];
      if (indexing) notices.push(INDEXING);
      if (result.regexFallbackError !== undefined) notices.push(`Invalid regex (${result.regexFallbackError}): searched as plain text`);
      const next = isFuzzy ? null : result.nextCursor;
      if (next !== null) {
        // fff finishes the file it is in, so a page short of the limit stopped at the time budget.
        notices.push(
          result.items.length < limit
            ? `Stopped at the ${GREP_TIME_BUDGET_MS / 1000}s limit having searched ${next._offset} of ${result.filteredFileCount} files; continue with cursor="${next._offset}"`
            : `More matches: continue with cursor="${next._offset}"`,
        );
      }
      const body = lines.length === 0 ? "No matches found" : isFuzzy ? `[No exact matches; these are close]\n${lines.join("\n")}` : lines.join("\n");
      return finish(body, notices, { root: scope.root, shown: result.items.length, ...(isFuzzy ? { fuzzy: true as const } : {}) }, maxResultChars);
    });
  },
});

export const findTool = (indexes: FffIndexesService): Tool<FindInput> => ({
  name: "find",
  description: `Find files by path. Fuzzy and typo-tolerant, it matches the whole path relative to the working directory, not just the file name: 'profile' finds chrome/browser/profiles/x.cc too. More words narrow it, in any order; keep to one or two. Use it first when the user names a concept, feature, or file. For an exact name use a glob in path ('**/profile.h', 'src/**/*.ts'); an empty pattern with a folder as path lists the folder. For contents, use grep. Files changed recently rank higher, and files git sees changed are tagged. Returns up to ${DEFAULT_FIND_LIMIT} files by default, and only a few when the best match is weak.`,
  input: FindInput,
  replay: "safe",
  parallel: "safe",
  execute: async (input, { cwd, signal, maxResultChars }) => {
    throwIfAborted(signal);
    const offset = offsetOf(input.cursor);
    const scope = await scopeOf(input.path, input.exclude, cwd);
    const limit = clamp(input.limit, DEFAULT_FIND_LIMIT, 1, FIND_LIMIT_MAX);
    const pattern = input.pattern.trim();
    return indexes.use(scope.root, async (finder) => {
      const indexing = await scanned(finder, signal);
      const query = [...scope.constraints, pattern].join(" ").trim();
      // A later page is the first `offset + limit` from the top, so a cursor is just a count.
      const result = unwrap(finder.fileSearch(query, { pageIndex: 0, pageSize: offset + limit }));
      const page = result.items.slice(offset);
      // fff scores a perfect match about 12 a character: a best match under half that is scattered fuzzy noise.
      const weak = offset === 0 && pattern !== "" && page.length > 0 && (result.scores[0]?.total ?? 0) < pattern.length * 6;
      const shown = weak ? page.slice(0, WEAK_SAMPLE) : page;

      const notices: string[] = [];
      if (indexing) notices.push(INDEXING);
      if (weak) notices.push(`Only weak, scattered matches for "${pattern}": showing ${shown.length} of ${result.totalMatched}`);
      const remaining = result.totalMatched - offset - shown.length;
      if (!weak && remaining > 0) notices.push(`${remaining} more: continue with cursor="${offset + shown.length}"`);
      const body = shown.length === 0 ? "No files found" : shown.map((item) => `${scope.display(item.relativePath)}${annotation(item)}`).join("\n");
      return finish(body, notices, { root: scope.root, shown: shown.length }, maxResultChars);
    });
  },
});
