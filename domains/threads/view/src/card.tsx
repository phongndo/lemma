import { Show, createMemo } from "solid-js";
import type { SessionEvent } from "@lemma/sessions";
import type { ThreadsService } from "@lemma/threads";

/** What a thread's branch has cost: its answers, its failed calls, and its summaries, as their usage priced them. */
export const branchCost = (branch: readonly SessionEvent[]): number => {
  let total = 0;
  for (const { data } of branch) {
    if (data.type === "message" || data.type === "attempt") total += "usage" in data.message ? data.message.usage.cost.total : 0;
    else if (data.type === "compaction") total += data.usage?.cost.total ?? 0;
  }
  return total;
};

/** A cost in dollars, to the cent: `$0.42`, and `under $0.01` for less. */
export const formatCost = (total: number): string => (total < 0.01 ? "under $0.01" : `$${total.toFixed(2)}`);

/** The thread card's cost row, once the thread has cost anything (a model its provider prices). */
export function CostRow(props: { threads: ThreadsService }) {
  const cost = createMemo(() => branchCost(props.threads.branch()));
  return (
    <Show when={cost() > 0}>
      <div class="menu-item" data-tip="What this thread's model calls have cost, as their providers price them">
        <span class="menu-check" />
        <span class="menu-label">Cost</span>
        <span class="menu-hint">{formatCost(cost())}</span>
      </div>
    </Show>
  );
}
