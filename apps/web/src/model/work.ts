import type { Block, Item } from "./transcript.ts";

/**
 * A turn's folded work as rows, the way a work log reads: each thought, tool
 * call, and remark on a line of its own, and calls made one after another
 * gathered under one line that says what they did ("Read 3 files, ran 2
 * commands"). Pure.
 */

export type WorkRow =
  | {
      readonly kind: "block";
      readonly key: string;
      readonly at: number;
      readonly block: Block;
      /** What the block's thought is opened and closed by: its step, so it is the same while streaming and once logged. */
      readonly scope: string;
    }
  /** Anything else in the work: a failed attempt, a result without its call. */
  | { readonly kind: "item"; readonly key: string; readonly at: number; readonly item: Item };

export type WorkEntry =
  | WorkRow
  | {
      readonly kind: "group";
      readonly key: string;
      readonly at: number;
      /** What the group's calls did, in a sentence. */
      readonly summary: string;
      /** The tool names its calls used, in order. */
      readonly tools: readonly string[];
      readonly failed: number;
      readonly rows: readonly WorkRow[];
    };

/** What a kind of call did, past tense, for one and for many. */
const ACTIONS: ReadonlyMap<string, readonly [verb: string, one: string, many: string]> = new Map([
  ["bash", ["ran", "command", "commands"]],
  ["read", ["read", "file", "files"]],
  ["edit", ["changed", "file", "files"]],
  ["grep", ["searched", "time", "times"]],
  ["ls", ["listed", "directory", "directories"]],
]);
/** Tools that read as another's action: a search by name is a search, writing a file changes it. Maps, as a tool may be named anything (`constructor`). */
const KIND: ReadonlyMap<string, string> = new Map([
  ["find", "grep"],
  ["write", "edit"],
]);

/** At most this many kinds are named; the rest are counted. */
const NAMED = 2;

/** What a run of tool calls did, in a sentence: "Ran 3 commands and changed 1 file", "Read 3 files, ran 2 commands, and 1 other action". */
export const summarizeTools = (names: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const name of names) {
    const alias = KIND.get(name) ?? name;
    const kind = ACTIONS.has(alias) ? alias : "";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const known = [...counts].filter(([kind]) => kind !== "");
  const named = known.slice(0, NAMED).map(([kind, count]) => {
    const [verb, one, many] = ACTIONS.get(kind)!;
    return `${verb} ${count} ${count === 1 ? one : many}`;
  });
  const rest = names.length - known.slice(0, NAMED).reduce((sum, [, count]) => sum + count, 0);
  const parts =
    named.length === 0
      ? [`used ${rest} ${rest === 1 ? "tool" : "tools"}`]
      : rest === 0
        ? named
        : [...named, `${rest} other ${rest === 1 ? "action" : "actions"}`];
  const sentence = parts.length > 2 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts.join(" and ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** The rows of `items`, in order: an assistant message's blocks one by one, anything else whole. */
export const workRows = (items: readonly Item[]): WorkRow[] =>
  items.flatMap((item): WorkRow[] => {
    if (item.kind === "assistant")
      return item.blocks
        .filter((block) => block.kind !== "text" || block.text.trim() !== "")
        .filter((block) => block.kind !== "thinking" || block.redacted || block.text.trim() !== "")
        .map((block) => ({ kind: "block", key: block.key, at: item.at, block, scope: item.stepId ?? item.id }));
    return [{ kind: "item", key: item.id, at: item.at, item }];
  });

const isTool = (row: WorkRow): row is Extract<WorkRow, { kind: "block" }> & { block: Extract<Block, { kind: "tool" }> } =>
  row.kind === "block" && row.block.kind === "tool";

/**
 * The entries a fold shows: rows as they are, except that calls made one after
 * another, with only thoughts between them, gather under one line once there
 * are at least `least` of them. A remark, an attempt, or the like ends a run.
 */
export const workEntries = (items: readonly Item[], least = 2): WorkEntry[] => {
  const entries: WorkEntry[] = [];
  let run: WorkRow[] = [];
  const close = () => {
    const tools = run.filter(isTool);
    if (tools.length < least) entries.push(...run);
    else {
      // Thoughts after the run's last call stay outside it: they lead into what comes next.
      const last = run.lastIndexOf(tools.at(-1)!);
      entries.push({
        kind: "group",
        key: `group:${run[0]!.key}`,
        at: run[0]!.at,
        summary: summarizeTools(tools.map((row) => row.block.call.name)),
        tools: tools.map((row) => row.block.call.name),
        failed: tools.filter((row) => row.block.result?.isError === true).length,
        rows: run.slice(0, last + 1),
      });
      entries.push(...run.slice(last + 1));
    }
    run = [];
  };
  for (const row of workRows(items)) {
    if (isTool(row) || (row.kind === "block" && row.block.kind === "thinking")) run.push(row);
    else {
      close();
      entries.push(row);
    }
  }
  close();
  return entries;
};
