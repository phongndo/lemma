/**
 * `@lemma/tools/diff`: the unified diff of a change to a text file (`unifiedPatch`), as the bundled `edit` and
 * `apply_patch` put it in their results' details, for the chat to show.
 */

// A minimal line diff and unified patch writer, enough for showing a change.

type Op = { readonly kind: "same" | "del" | "add"; readonly line: string };

/** Lines with their terminators, so a missing final newline is a visible difference. */
const splitLines = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+/g) ?? [];

/** Up to this many cells the middle is diffed by an exact LCS table. */
const MAX_CELLS = 4_000_000;
/** Past this many lines deleted and added, a middle too big for the table is shown as one replaced block: Myers' trace then holds about as many cells. */
const MAX_DIFFERENCES = 2_000;

/** The middle by the LCS table: `lcs[i][j]` is the LCS length of `a[i..]` and `b[j..]`; ties delete first. */
function lcsOps(a: readonly string[], b: readonly string[], ops: Op[]): void {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "del", line: a[i++]! });
    } else {
      ops.push({ kind: "add", line: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++]! });
  while (j < m) ops.push({ kind: "add", line: b[j++]! });
}

/**
 * The middle by Myers' O((n+m)·D) shortest edit script, for one too big for the table (a change at each end of a long
 * file), each run of changes its deletions then its additions; undefined past `MAX_DIFFERENCES`.
 */
function myersOps(a: readonly string[], b: readonly string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  // v[k + d + 1] is how far along `a` diagonal k reaches; `trace[d]` is v as step d found it, its diagonals -d-1..d+1.
  const trace: Int32Array[] = [];
  let v = new Int32Array(3);
  for (let d = 0; d <= MAX_DIFFERENCES; d++) {
    trace.push(v);
    const next = new Int32Array(2 * d + 5);
    const at = (k: number) => v[k + d + 1]!;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[k + d + 2] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
    v = next;
  }
  return undefined;
}

function backtrack(a: readonly string[], b: readonly string[], trace: readonly Int32Array[], steps: number): Op[] {
  const reversed: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = steps; d > 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    // The snake after the step, then the step: an addition (down) or a deletion.
    while (x > (down ? previousX : previousX + 1) && y > (down ? previousY + 1 : previousY)) {
      reversed.push({ kind: "same", line: a[--x]! });
      y--;
    }
    if (down) reversed.push({ kind: "add", line: b[--y]! });
    else reversed.push({ kind: "del", line: a[--x]! });
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: "same", line: a[--x]! });
    y--;
  }
  const ops = reversed.reverse();
  // Each run of changes as its deletions, then its additions, as unified diffs show them.
  for (let start = 0; start < ops.length;) {
    if (ops[start]!.kind === "same") {
      start++;
      continue;
    }
    let end = start;
    while (end < ops.length && ops[end]!.kind !== "same") end++;
    const run = ops.slice(start, end);
    ops.splice(start, run.length, ...run.filter((op) => op.kind === "del"), ...run.filter((op) => op.kind === "add"));
    start = end;
  }
  return ops;
}

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
  if (midA.length * midB.length <= MAX_CELLS) lcsOps(midA, midB, ops);
  else {
    const found = myersOps(midA, midB);
    if (found !== undefined) ops.push(...found);
    else {
      for (const line of midA) ops.push({ kind: "del", line });
      for (const line of midB) ops.push({ kind: "add", line });
    }
  }
  for (const line of a.slice(endA)) ops.push({ kind: "same", line });
  return ops;
}

/** Characters compared at once, as strings, before the one that differs is looked for. */
const BLOCK = 4096;

/** How many leading characters `a` and `b` share, up to `limit`. */
function commonPrefix(a: string, b: string, limit: number): number {
  let at = 0;
  while (at + BLOCK <= limit && a.slice(at, at + BLOCK) === b.slice(at, at + BLOCK)) at += BLOCK;
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  return at;
}

/** How many trailing characters `a` and `b` share, up to `limit`. */
function commonSuffix(a: string, b: string, limit: number): number {
  let shared = 0;
  while (shared + BLOCK <= limit && a.slice(a.length - shared - BLOCK, a.length - shared) === b.slice(b.length - shared - BLOCK, b.length - shared))
    shared += BLOCK;
  while (shared < limit && a.charCodeAt(a.length - shared - 1) === b.charCodeAt(b.length - shared - 1)) shared++;
  return shared;
}

const isLineStart = (text: string, at: number) => at === 0 || text.charCodeAt(at - 1) === 10;

const newlinesIn = (text: string, end: number) => {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) count++;
  return count;
};

/**
 * The lines both sides share at their start and end, found by comparing characters, so a change to a long file splits
 * only what changed: the lines in `[0, start)` of both, and from `endBefore`/`endAfter` on.
 */
function sharedEnds(before: string, after: string): { readonly start: number; readonly endBefore: number; readonly endAfter: number } {
  const shorter = Math.min(before.length, after.length);
  const prefix = commonPrefix(before, after, shorter);
  // The line the first difference is in starts after the newline before it.
  const start = prefix === 0 ? 0 : before.lastIndexOf("\n", prefix - 1) + 1;
  const suffix = commonSuffix(before, after, shorter - start);
  // The first line wholly in the shared end, starting a line on both sides.
  let endBefore = before.length - suffix;
  const shift = after.length - before.length;
  if (!(isLineStart(before, endBefore) && isLineStart(after, endBefore + shift))) {
    const newline = before.indexOf("\n", endBefore);
    endBefore = newline === -1 ? before.length : newline + 1;
  }
  return { start, endBefore, endAfter: endBefore + shift };
}

const render = (prefix: string, line: string) => (line.endsWith("\n") ? `${prefix}${line}` : `${prefix}${line}\n\\ No newline at end of file\n`);

export interface UnifiedPatch {
  /** Standard unified diff (`---`/`+++` headers, `@@` hunks). Empty when nothing changed. */
  readonly patch: string;
  /** First changed line in the new file, for editor navigation. */
  readonly firstChangedLine?: number;
}

/**
 * The unified diff from `before` to `after`, with `context` lines around each change. `file` names both sides, or each
 * (`{ from, to }`: a moved file, or `/dev/null` for one added or deleted).
 */
export function unifiedPatch(file: string | { readonly from: string; readonly to: string }, before: string, after: string, context = 4): UnifiedPatch {
  if (before === after) return { patch: "" };
  // Only what changed is split and diffed; of the lines around it, the `context` nearest it are kept, and the rest counted.
  const { start: changed, endBefore, endAfter } = sharedEnds(before, after);
  const leading: string[] = [];
  for (let end = changed; leading.length < context && end > 0;) {
    const from = end <= 1 ? 0 : before.lastIndexOf("\n", end - 2) + 1;
    leading.unshift(before.slice(from, end));
    end = from;
  }
  const trailing: string[] = [];
  for (let from = endBefore; trailing.length < context && from < before.length;) {
    const newline = before.indexOf("\n", from);
    const end = newline === -1 ? before.length : newline + 1;
    trailing.push(before.slice(from, end));
    from = end;
  }
  const ops = [
    ...leading.map((line): Op => ({ kind: "same", line })),
    ...diffLines(splitLines(before.slice(changed, endBefore)), splitLines(after.slice(changed, endAfter))),
    ...trailing.map((line): Op => ({ kind: "same", line })),
  ];
  const skipped = newlinesIn(before, changed) - leading.length;
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldCount = skipped;
  let newCount = skipped;
  const changes: number[] = [];
  ops.forEach((op, i) => {
    oldBefore.push(oldCount);
    newBefore.push(newCount);
    if (op.kind !== "add") oldCount++;
    if (op.kind !== "del") newCount++;
    if (op.kind !== "same") changes.push(i);
  });
  if (changes.length === 0) return { patch: "" };

  const { from, to } = typeof file === "string" ? { from: file, to: file } : file;
  let out = `--- ${from}\n+++ ${to}\n`;
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
