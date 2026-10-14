/*
 * How commands lay out text, so every command's tables and figures read
 * alike: the `lemma` command's own and those plugins add. Figures are the
 * web app's (`@lemma/client/format`), so both show the same.
 */

export { formatCost, formatDuration, formatTokens, formatUsage } from "@lemma/client/format";

/** Rows as columns, each padded to its widest cell; the last column is not padded. */
export const table = (rows: readonly (readonly string[])[]): string => {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)), []);
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

/** A local date and time to the minute, `2026-10-13 14:03`. */
export const time = (ms: number): string => {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};
