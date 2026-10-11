/** A minimal line diff and unified patch writer, enough for showing an edit. */

type Op = { readonly kind: "same" | "del" | "add"; readonly line: string };

/** Lines with their terminators, so a missing final newline is a visible difference. */
const splitLines = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+/g) ?? [];

/** Above this many cells the middle is shown as one replaced block instead of an exact LCS. */
const MAX_CELLS = 4_000_000;

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = a.slice(0, start).map((line) => ({ kind: "same", line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    for (const line of midA) ops.push({ kind: "del", line });
    for (const line of midB) ops.push({ kind: "add", line });
  } else {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..].
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: "same", line: midA[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        ops.push({ kind: "del", line: midA[i++]! });
      } else {
        ops.push({ kind: "add", line: midB[j++]! });
      }
    }
    while (i < n) ops.push({ kind: "del", line: midA[i++]! });
    while (j < m) ops.push({ kind: "add", line: midB[j++]! });
  }
  for (const line of a.slice(endA)) ops.push({ kind: "same", line });
  return ops;
}

const render = (prefix: string, line: string) => (line.endsWith("\n") ? `${prefix}${line}` : `${prefix}${line}\n\\ No newline at end of file\n`);

export interface Patch {
  /** Standard unified diff (`---`/`+++` headers, `@@` hunks). Empty when nothing changed. */
  readonly patch: string;
  /** First changed line in the new file, for editor navigation. */
  readonly firstChangedLine?: number;
}

export function unifiedPatch(file: string, before: string, after: string, context = 4): Patch {
  const ops = diffLines(splitLines(before), splitLines(after));
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldCount = 0;
  let newCount = 0;
  const changes: number[] = [];
  ops.forEach((op, i) => {
    oldBefore.push(oldCount);
    newBefore.push(newCount);
    if (op.kind !== "add") oldCount++;
    if (op.kind !== "del") newCount++;
    if (op.kind !== "same") changes.push(i);
  });
  if (changes.length === 0) return { patch: "" };

  let out = `--- ${file}\n+++ ${file}\n`;
  for (let c = 0; c < changes.length;) {
    const start = Math.max(0, changes[c]! - context);
    let end = Math.min(ops.length, changes[c]! + 1 + context);
    let next = c + 1;
    while (next < changes.length && changes[next]! - context <= end) {
      end = Math.min(ops.length, changes[next]! + 1 + context);
      next++;
    }
    const hunk = ops.slice(start, end);
    const oldLines = hunk.filter((op) => op.kind !== "add").length;
    const newLines = hunk.filter((op) => op.kind !== "del").length;
    const oldStart = oldLines === 0 ? oldBefore[start]! : oldBefore[start]! + 1;
    const newStart = newLines === 0 ? newBefore[start]! : newBefore[start]! + 1;
    out += `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n`;
    for (const op of hunk) out += render(op.kind === "same" ? " " : op.kind === "del" ? "-" : "+", op.line);
    c = next;
  }
  const first = changes[0]!;
  return { patch: out, firstChangedLine: newBefore[first]! + 1 };
}
