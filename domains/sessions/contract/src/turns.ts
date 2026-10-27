import type { SessionEvent } from "./sessions.ts";

/**
 * A branch's events folded into turns, an event at a time: what a view of a thread folds the branch into, the
 * trajectory's turns (`trajectory`) and the transcript's (`createProjector` in `@lemma/threads`) alike. Made for a
 * branch whole (`start` of `createTurnProjector`, as an event may name one after it), then fed its events in order,
 * and fed on as the branch grows.
 */
export interface TurnFold<Turn> {
  /** The turns so far, in branch order. A fold adds turns after them and changes them in place, but never moves one. */
  readonly turns: readonly Turn[];
  /**
   * Folds in `branch[position]`, every event before it fed already. Returns the turns it changed (one it starts is new,
   * so need not be named), or `"afresh"` when it changes what was folded on the branch as known when the fold was made:
   * the branch is then folded again from its start. A fold made for the branch it is fed never asks that.
   */
  readonly feed: (branch: readonly SessionEvent[], position: number) => Iterable<Turn> | "afresh";
}

/**
 * Views of a branch's turns, for a view that follows a thread as its branch grows at its end: given the branch it had
 * with more at the end, it feeds the fold only the events appended, and a turn they did not change keeps the view it
 * had, so a keyed list keeps its rows. Any other branch (a checkout, another thread) is folded from its start, by a
 * fold `start` makes for it. `view` makes a turn's view, given the one it had, which it may keep when the turn shows
 * the same. The list is the one it returned before while every view in it is.
 */
export function createTurnProjector<Turn, View>(
  start: (branch: readonly SessionEvent[]) => TurnFold<Turn>,
  view: (turn: Turn, before: View | undefined) => View,
): (branch: readonly SessionEvent[]) => readonly View[] {
  let last: { readonly branch: readonly SessionEvent[]; readonly fold: TurnFold<Turn>; readonly views: readonly View[] } | undefined;
  return (branch) => {
    const before = last?.branch ?? [];
    const read = before.length;
    // A branch is a path from its root: the same first event, and the same event where the last one ended, are the same
    // events before it.
    const grown = read > 0 && branch.length >= read && branch[0] === before[0] && branch[read - 1] === before[read - 1];
    if (grown && branch.length === read) return last!.views;
    let carried = grown ? last!.fold : undefined;
    const changed = new Set<Turn>();
    for (let position = read; carried !== undefined && position < branch.length; position++) {
      const touched = carried.feed(branch, position);
      if (touched === "afresh") carried = undefined;
      else for (const turn of touched) changed.add(turn);
    }
    if (carried === undefined) {
      const fold = start(branch);
      for (let position = 0; position < branch.length; position++) fold.feed(branch, position);
      last = { branch, fold, views: fold.turns.map((turn) => view(turn, undefined)) };
      return last.views;
    }
    const { turns } = carried;
    const had = last!.views;
    let views: View[] | undefined;
    const remake = (at: number) => {
      const made = view(turns[at]!, had[at]);
      if (made !== had[at]) (views ??= had.slice())[at] = made;
    };
    // Each turn keeps its place: the views of those changed, and of those added after them.
    for (const turn of changed) {
      const at = turns.lastIndexOf(turn);
      if (at !== -1 && at < had.length) remake(at);
    }
    for (let at = had.length; at < turns.length; at++) remake(at);
    last = { branch, fold: carried, views: views ?? had };
    return last.views;
  };
}
