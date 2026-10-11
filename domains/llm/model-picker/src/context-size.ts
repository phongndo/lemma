/** A context window for display: `1_000_000` → `1M`, `203_000` → `203K`. */
export const contextSize = (tokens: number): string => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
