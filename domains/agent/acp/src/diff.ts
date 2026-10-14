/** One line of a change as an approval shows it. */
export interface DiffLine {
  readonly kind: "context" | "removed" | "added" | "skipped";
  readonly text: string;
}

/** Lines of context kept around a change. */
const CONTEXT = 2;

/**
 * What a change does, as lines: the lines both texts share before and after it as context (a few of each), the old
 * lines it removes, and the new ones it adds; a new file is all added. At most `max` changed lines, then a count.
 */
export function changeLines(oldText: string | null, newText: string, max = 40): DiffLine[] {
  const before = oldText === null || oldText === "" ? [] : oldText.split("\n");
  const after = newText.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const lines: DiffLine[] = [];
  if (start > CONTEXT) lines.push({ kind: "skipped", text: `${start - CONTEXT} unchanged lines` });
  for (const text of before.slice(Math.max(0, start - CONTEXT), start)) lines.push({ kind: "context", text });
  const changed = [
    ...before.slice(start, before.length - end).map((text): DiffLine => ({ kind: "removed", text })),
    ...after.slice(start, after.length - end).map((text): DiffLine => ({ kind: "added", text })),
  ];
  lines.push(...changed.slice(0, max));
  if (changed.length > max) lines.push({ kind: "skipped", text: `${changed.length - max} more changed lines` });
  for (const text of after.slice(after.length - end, after.length - end + CONTEXT)) lines.push({ kind: "context", text });
  return lines;
}
