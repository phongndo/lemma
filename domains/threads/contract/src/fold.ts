import type { AssistantItem, Item, ToolResultView, TurnView } from "./transcript.ts";

/**
 * A turn as the reader wants it back: its prompt, the work behind the answer
 * (thinking, tool calls, the text between them, failed attempts) folded, and
 * the answer. The work folds in runs, one between each two items the turn
 * shows on its own (a prompt that joined it, a steer, a compaction), so what
 * was done after a steer shows after it, in the log's order. Pure; items keep
 * their identity except the last assistant message, which is split into its
 * work and its answer (the text after its last tool call or thought).
 */

export type TurnEntry =
  | { readonly kind: "item"; readonly item: Item; /** Show the item's stop note (the answer's, never a split-off part's). */ readonly note: boolean }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly items: readonly Item[];
      readonly tools: number;
      readonly failed: number;
      /** When the run began: the turn's start, or the item it follows. */
      readonly since: number;
      /** How long the run took, once over: to the item after it, or the turn's end. */
      readonly duration?: number;
      /** The running turn's last run: its work so far, which its streaming step joins. */
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
export const answerText = (turn: TurnView): string => endingText(turn.items);

/** The text the last assistant message of `items` ends with, as `answerText` reads a turn's. */
export const endingText = (items: readonly Item[]): string => {
  let last = items.length - 1;
  while (last >= 0 && items[last]!.kind !== "assistant") last--;
  if (last === -1) return "";
  const blocks = (items[last] as AssistantItem).blocks;
  let split = blocks.length;
  while (split > 0 && blocks[split - 1]!.kind === "text") split--;
  return blocks
    .slice(split)
    .map((block) => (block.kind === "text" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
};

/** The call failed on its own: an error the stop did not cause (`ToolResultView.stopped`). */
export const callFailed = (result: ToolResultView | undefined): boolean => result?.isError === true && result.stopped !== true;

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
        if (callFailed(block.result)) failed++;
      }
    }
  }
  return { tools, failed };
};

/** A finished turn's last assistant message: at `index`, its work part (none when it is all answer), and its answer. */
interface Final {
  readonly index: number;
  readonly work: AssistantItem | undefined;
  readonly answer: TurnEntry;
}

/**
 * The turn's items as entries, each run of work between two items shown on
 * their own folded into one. The first run has the turn's key
 * (`<turn>:work`), whatever opened the turn, and each later one the key of
 * the item it follows, so a run has its key from before its first step lands
 * to after the turn ends. A running turn (`endedAt` undefined) ends with a
 * live run, empty until its streaming step lands, for that step to join.
 * `final`'s answer goes right after the run that holds its work.
 */
const runs = (turn: TurnView, endedAt: number | undefined, final?: Final): TurnEntry[] => {
  const entries: TurnEntry[] = [];
  let run: Item[] = [];
  let ran = false;
  let after: Item | undefined;
  let since = turn.startedAt;
  let answer: TurnEntry | undefined;
  const close = (end: number | undefined, live: boolean) => {
    if (run.length > 0 || live) {
      entries.push({
        kind: "work",
        key: after === undefined ? `${turn.key}:work` : `${turn.key}:work:${after.id}`,
        items: run,
        ...tally(run),
        since,
        ...(end === undefined ? {} : { duration: end - since }),
        ...(live ? { live } : {}),
      });
      run = [];
      ran = true;
    }
    if (answer !== undefined) entries.push(answer);
    answer = undefined;
  };
  turn.items.forEach((item, index) => {
    if (item.kind === "user" || item.kind === "compaction" || item.kind === "context") {
      close(item.at, false);
      entries.push({ kind: "item", item, note: true });
      // The prompts that open the turn come before its first run, which keeps the turn's key and start.
      if (ran) {
        after = item;
        since = item.at;
      }
      return;
    }
    if (index !== final?.index) return void run.push(item);
    answer = final.answer;
    if (final.work !== undefined) run.push(final.work);
  });
  close(endedAt, endedAt === undefined);
  return entries;
};

/**
 * A running turn: its prompt, then its work so far in runs, the last one
 * live, which its streaming step joins, as `foldTurn` shows them once it ends.
 * A steer the turn placed ends the run before it, and the work after it is
 * the run after it: so it shows where it joined, never under work the model
 * did after reading it, and where it stays once the turn ends. Each run has
 * the finished turn's key, so it is the same fold, opened or closed, once the
 * turn ends. Only the turn that is running is folded this way: a branch that
 * stops inside a turn has no end either, and is not running.
 */
export const foldRunning = (turn: TurnView): readonly TurnEntry[] | undefined => (turn.end !== undefined ? undefined : runs(turn, undefined));

/** The folded entries of `turn`, or undefined to show it as it is: still running, or nothing before its answer to fold. */
export const foldTurn = (turn: TurnView): readonly TurnEntry[] | undefined => {
  if (turn.end === undefined) return undefined;
  let last = turn.items.length - 1;
  while (last >= 0 && turn.items[last]!.kind !== "assistant") last--;
  const final = last === -1 ? undefined : (turn.items[last] as AssistantItem);
  let split = final?.blocks.length ?? 0;
  while (split > 0 && final!.blocks[split - 1]!.kind === "text") split--;
  const entries = runs(
    turn,
    turn.endedAt,
    final === undefined
      ? undefined
      : {
          index: last,
          work: split === 0 ? undefined : { ...final, blocks: final.blocks.slice(0, split) },
          answer: { kind: "item", item: split === 0 ? final : { ...final, blocks: final.blocks.slice(split) }, note: true },
        },
  );
  return entries.some((entry) => entry.kind === "work") ? entries : undefined;
};
