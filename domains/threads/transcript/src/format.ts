import { formatCost, formatTokens } from "@lemma/client/format";
import { cacheHitRate } from "@lemma/llm";
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
    `Cache read ${usage.cacheRead.toLocaleString()}, write ${usage.cacheWrite.toLocaleString()}${usage.cacheRead === 0 ? "" : ` (${percent(cacheHitRate(usage)!)} of input)`}`,
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

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** Whole seconds, then minutes: a label that ticks without jumping in width every tenth. */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/**
 * When a prompt was sent, as the line under it says (`label`): the time today, the day too before then ("Yesterday",
 * a date, and the year when not this one); and the moment in full (`full`), as its tooltip says. In local time.
 */
export const sentTime = (at: number, now: number, locale?: string): { readonly label: string; readonly full: string } => {
  const date = new Date(at);
  const today = new Date(now);
  const days = Math.round((midnight(today) - midnight(date)) / 86_400_000);
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const label =
    days === 0
      ? time
      : days === 1
        ? `Yesterday ${time}`
        : date.toLocaleString(locale, {
            month: "short",
            day: "numeric",
            ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
            hour: "numeric",
            minute: "2-digit",
          });
  return { label, full: date.toLocaleString(locale, { dateStyle: "full", timeStyle: "short" }) };
};

/** The local midnight starting `date`'s day: days between two count whole, across a daylight-saving change too. */
const midnight = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
