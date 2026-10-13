import { cacheHitRate } from "@lemma/llm";
import type { SessionEvent } from "@lemma/sessions";

/** The share of the branch's last answer's input that the provider's cache served; undefined before one. */
export const lastCacheHit = (branch: readonly SessionEvent[]): number | undefined => {
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = branch[i]!.data;
    if (data.type !== "message" || data.message.role !== "assistant") continue;
    const rate = cacheHitRate(data.message.usage);
    if (rate !== undefined) return rate;
  }
  return undefined;
};

export const percent = (share: number): string => `${Math.round(share * 100)}%`;
