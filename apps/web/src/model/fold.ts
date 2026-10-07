import type { AssistantItem, Item, TurnView } from "./transcript.ts";

/**
 * A finished turn as the reader wants it back: the prompt, the work behind
 * the answer (thinking, tool calls, the text between them, failed attempts)
 * folded into one entry, and the answer. Pure; items keep their identity
 * except the last assistant message, which is split into its work and its
 * answer (the text after its last tool call or thought).
 */

export type TurnEntry =
  | { readonly kind: "item"; readonly item: Item; /** Show the item's stop note (the answer's, never a split-off part's). */ readonly note: boolean }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly items: readonly Item[];
      readonly tools: number;
      readonly failed: number;
      readonly duration?: number;
      /** The turn is still running: this is its work so far, and its streaming step joins it. */
      readonly live?: boolean;
    };

/**
 * An entry's key, the same while the turn runs and after it ends: a fold makes
 * new entry objects each time, so a view keys what it shows by this.
 */
export const entryKey = (entry: TurnEntry): string => (entry.kind === "work" ? entry.key : entry.item.id);

/**
 * The turn's answer as markdown source: the text its last assistant message
 * ends with, after its last tool call or thought (what a folded turn shows
 * below the fold). Empty when that message ends in a tool call.
 */
export const answerText = (turn: TurnView): string => {
  let last = turn.items.length - 1;
  while (last >= 0 && turn.items[last]!.kind !== "assistant") last--;
  if (last === -1) return "";
  const blocks = (turn.items[last] as AssistantItem).blocks;
  let split = blocks.length;
  while (split > 0 && blocks[split - 1]!.kind === "text") split--;
  return blocks
    .slice(split)
    .map((block) => (block.kind === "text" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
};

const tally = (items: readonly Item[]) => {
  let tools = 0;
  let failed = 0;
  for (const item of items) {
    if (item.kind === "orphan-result") {
      tools++;
      if (item.message.isError) failed++;
    } else if (item.kind === "assistant" || item.kind === "attempt") {
      for (const block of item.blocks) {
        if (block.kind !== "tool") continue;
        tools++;
        if (block.result?.isError) failed++;
      }
    }
  }
  return { tools, failed };
};

/**
 * A running turn: its prompt, then all its work so far as one live fold,
 * which its streaming step joins at the end; undefined once it has ended.
 * A steer or a compaction after the work began stays where it happened,
 * inside the fold, so what answers it comes after it. The fold has the
 * finished turn's key, so it is the same fold, opened or closed, once the
 * turn ends. Only the turn that is running is folded this way: a branch
 * that stops inside a turn has no end either, and is not running.
 */
export const foldRunning = (turn: TurnView): readonly TurnEntry[] | undefined => {
  if (turn.end !== undefined) return undefined;
  const entries: TurnEntry[] = [];
  const work: Item[] = [];
  for (const item of turn.items) {
    if (work.length === 0 && (item.kind === "user" || item.kind === "compaction")) entries.push({ kind: "item", item, note: true });
    else work.push(item);
  }
  entries.push({ kind: "work", key: `${turn.key}:work`, items: work, ...tally(work), live: true });
  return entries;
};

/** The folded entries of `turn`, or undefined to show it as it is: still running, or nothing before its answer to fold. */
export const foldTurn = (turn: TurnView): readonly TurnEntry[] | undefined => {
  if (turn.end === undefined) return undefined;
  let last = turn.items.length - 1;
  while (last >= 0 && turn.items[last]!.kind !== "assistant") last--;
  const final = last === -1 ? undefined : (turn.items[last] as AssistantItem);
  let split = final?.blocks.length ?? 0;
  while (split > 0 && final!.blocks[split - 1]!.kind === "text") split--;
  const work: Item[] = [];
  let tools = 0;
  let failed = 0;
  const entries: TurnEntry[] = [];
  let workAt = -1;
  turn.items.forEach((item, index) => {
    if (item.kind === "user" || item.kind === "compaction") return void entries.push({ kind: "item", item, note: true });
    if (workAt === -1) workAt = entries.length;
    if (item.kind !== "assistant") {
      if (item.kind === "orphan-result") {
        tools++;
        if (item.message.isError) failed++;
      }
      return void work.push(item);
    }
    const blocks = index === last ? item.blocks.slice(0, split) : item.blocks;
    for (const block of blocks)
      if (block.kind === "tool") {
        tools++;
        if (block.result?.isError) failed++;
      }
    if (index !== last) work.push(item);
    else if (blocks.length > 0) work.push({ ...item, blocks });
  });
  if (work.length === 0) return undefined;
  entries.splice(workAt, 0, {
    kind: "work",
    key: `${turn.key}:work`,
    items: work,
    tools,
    failed,
    ...(turn.endedAt === undefined ? {} : { duration: turn.endedAt - turn.startedAt }),
  });
  if (final !== undefined) entries.push({ kind: "item", item: split === 0 ? final : { ...final, blocks: final.blocks.slice(split) }, note: true });
  return entries;
};
