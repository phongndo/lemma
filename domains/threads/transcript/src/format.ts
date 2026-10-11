import { formatCost, formatTokens } from "@lemma/client/format";
import type { Usage } from "@lemma/llm";

interface UsageSummary {
  readonly input: string;
  readonly output: string;
  readonly cache?: string;
  readonly cost?: string;
  readonly title: string;
}

/** Compact footer text plus a detailed tooltip. Input includes cache reads/writes, as providers bill them. */
export const summarizeUsage = (usage: Usage): UsageSummary => {
  const cached = usage.cacheRead + usage.cacheWrite;
  const lines = [
    `Input ${(usage.input + cached).toLocaleString()} tokens`,
    `Output ${usage.output.toLocaleString()} tokens${usage.reasoning ? ` (${usage.reasoning.toLocaleString()} reasoning)` : ""}`,
    `Cache read ${usage.cacheRead.toLocaleString()}, write ${usage.cacheWrite.toLocaleString()}`,
    `Cost ${formatCost(usage.cost.total)} (in ${formatCost(usage.cost.input)}, out ${formatCost(usage.cost.output)}, cache ${formatCost(usage.cost.cacheRead + usage.cost.cacheWrite)})`,
  ];
  return {
    input: formatTokens(usage.input + cached),
    output: formatTokens(usage.output),
    ...(cached === 0 ? {} : { cache: `${formatTokens(usage.cacheRead)}${usage.cacheWrite ? ` +${formatTokens(usage.cacheWrite)}` : ""}` }),
    ...(usage.cost.total === 0 ? {} : { cost: formatCost(usage.cost.total) }),
    title: lines.join("\n"),
  };
};

/** Whole seconds, then minutes: a label that ticks without jumping in width every tenth. */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
