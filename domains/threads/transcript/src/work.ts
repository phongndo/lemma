import { callFailed } from "@lemma/threads";
import type { Block, Item } from "@lemma/threads";

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

/** What calls to a tool did, past tense, for one and for many (its view's `action`), when its view says. */
export type ActionOf = (name: string) => readonly [verb: string, one: string, many: string] | undefined;

/** At most this many kinds are named; the rest are counted. */
const NAMED = 2;

/**
 * What a run of tool calls did, in a sentence: "Ran 3 commands and changed 1 file", "Read 3 files, ran 2 commands, and
 * 1 other action". Calls whose tools say the same words are one kind; a call whose tool says none is counted.
 */
export const summarizeTools = (names: readonly string[], actionOf: ActionOf): string => {
  const kinds = new Map<string, { readonly words: readonly [string, string, string]; count: number }>();
  let rest = 0;
  for (const name of names) {
    const words = actionOf(name);
    if (words === undefined) {
      rest++;
      continue;
    }
    const key = words.join("\n");
    const kind = kinds.get(key) ?? { words, count: 0 };
    kind.count++;
    kinds.set(key, kind);
  }
  const shown = [...kinds.values()].slice(0, NAMED);
  rest += [...kinds.values()].slice(NAMED).reduce((sum, kind) => sum + kind.count, 0);
  const named = shown.map(({ words: [verb, one, many], count }) => `${verb} ${count} ${count === 1 ? one : many}`);
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
export const workEntries = (items: readonly Item[], actionOf: ActionOf, least = 2): WorkEntry[] => {
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
        summary: summarizeTools(
          tools.map((row) => row.block.call.name),
          actionOf,
        ),
        tools: tools.map((row) => row.block.call.name),
        failed: tools.filter((row) => callFailed(row.block.result)).length,
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

/** A tool call in a turn's work. */
export type ToolBlock = Extract<Block, { kind: "tool" }>;

/** Whether a tool's calls show the reader something outside the fold (its view's `display`), and while they run too (`live`). */
export type Shows = (name: string) => { readonly live: boolean } | undefined;

/**
 * The calls among a fold's `items` that show the reader something outside it (their view's `display`, which `shows`
 * tells), in order: those with a result, as a display is drawn for a call that has one, and those still running of a
 * view drawn live. A failed attempt's calls never ran, so they show nothing.
 */
export const displayedCalls = (items: readonly Item[], shows: Shows): ToolBlock[] =>
  items.flatMap((item) =>
    item.kind === "assistant"
      ? item.blocks.filter((block): block is ToolBlock => {
          if (block.kind !== "tool") return false;
          const view = shows(block.call.name);
          return view !== undefined && (block.result !== undefined || view.live);
        })
      : [],
  );

/** A fold's displays as drawn: each call's own, or a run of one tool's calls as one (its view's `displays`). */
export type DisplayEntry =
  | { readonly kind: "one"; readonly key: string; readonly block: ToolBlock }
  | { readonly kind: "many"; readonly key: string; readonly name: string; readonly blocks: readonly ToolBlock[] };

/** `blocks` as drawn: two or more calls of a tool in a row as one entry when `grouped` says its view draws them so. */
export const displayEntries = (blocks: readonly ToolBlock[], grouped: (name: string) => boolean): DisplayEntry[] => {
  const entries: DisplayEntry[] = [];
  for (let at = 0; at < blocks.length;) {
    const block = blocks[at]!;
    let end = at + 1;
    if (grouped(block.call.name)) while (end < blocks.length && blocks[end]!.call.name === block.call.name) end++;
    entries.push(
      end - at > 1
        ? { kind: "many", key: `many:${block.call.id}`, name: block.call.name, blocks: blocks.slice(at, end) }
        : { kind: "one", key: block.call.id, block },
    );
    at = end;
  }
  return entries;
};
