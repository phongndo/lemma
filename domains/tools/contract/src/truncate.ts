// Adapted from pi (MIT): packages/coding-agent/src/core/tools/truncate.ts.

/**
 * Tool output is bounded by two independent limits; whichever is hit first
 * wins. Only whole lines are returned, except when the single last line of a
 * tail exceeds the byte limit.
 */
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface Truncation {
  readonly content: string;
  readonly truncated: boolean;
  readonly truncatedBy: "lines" | "bytes" | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
  /** Tail truncation kept only the end of an overlong last line. */
  readonly lastLinePartial: boolean;
  /** Head truncation: the first line alone exceeds the byte limit, so nothing was returned. */
  readonly firstLineExceedsLimit: boolean;
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface Limits {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function countedLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

const untouched = (content: string, totalLines: number, totalBytes: number, maxLines: number, maxBytes: number): Truncation => ({
  content,
  truncated: false,
  truncatedBy: null,
  totalLines,
  totalBytes,
  outputLines: totalLines,
  outputBytes: totalBytes,
  lastLinePartial: false,
  firstLineExceedsLimit: false,
  maxLines,
  maxBytes,
});

/** Keeps the first lines: for file reads. */
export function truncateHead(content: string, limits: Limits = {}): Truncation {
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = bytes(content);
  const lines = countedLines(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) return untouched(content, totalLines, totalBytes, maxLines, maxBytes);
  const base = { truncated: true, totalLines, totalBytes, lastLinePartial: false, maxLines, maxBytes } as const;
  if (bytes(lines[0]!) > maxBytes) {
    return { ...base, content: "", truncatedBy: "bytes", outputLines: 0, outputBytes: 0, firstLineExceedsLimit: true };
  }
  const kept: string[] = [];
  let used = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const size = bytes(lines[i]!) + (i > 0 ? 1 : 0);
    if (used + size > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(lines[i]!);
    used += size;
  }
  if (kept.length >= maxLines && used <= maxBytes) truncatedBy = "lines";
  const output = kept.join("\n");
  return { ...base, content: output, truncatedBy, outputLines: kept.length, outputBytes: bytes(output), firstLineExceedsLimit: false };
}

/** Keeps the last lines: for command output, where errors and results are at the end. */
export function truncateTail(content: string, limits: Limits = {}): Truncation {
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = bytes(content);
  const lines = countedLines(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) return untouched(content, totalLines, totalBytes, maxLines, maxBytes);
  const kept: string[] = [];
  let used = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i]!;
    const size = bytes(line) + (kept.length > 0 ? 1 : 0);
    if (used + size > maxBytes) {
      truncatedBy = "bytes";
      if (kept.length === 0) {
        const end = tailBytes(line, maxBytes);
        kept.unshift(end);
        used = bytes(end);
        lastLinePartial = true;
      }
      break;
    }
    kept.unshift(line);
    used += size;
  }
  if (kept.length >= maxLines && used <= maxBytes) truncatedBy = "lines";
  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: bytes(output),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** The last `maxBytes` of a string, starting on a UTF-8 character boundary. */
export function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}
