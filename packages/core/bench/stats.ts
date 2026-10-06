// Comparing two sets of benchmark samples without assuming a distribution, as Go's benchstat does.

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Two-sided p-value of the Mann-Whitney U test that `a` and `b` come from the
 * same distribution: the normal approximation with tie and continuity
 * corrections, which is close enough from about eight samples a side.
 */
export function mannWhitney(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) throw new Error("mannWhitney needs samples on both sides");
  const all = [...a.map((value) => ({ value, first: true })), ...b.map((value) => ({ value, first: false }))].sort((x, y) => x.value - y.value);
  let rankSum = 0;
  let ties = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.value === all[i]!.value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k]!.first) rankSum += rank;
    const tied = j - i + 1;
    ties += tied ** 3 - tied;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const n = n1 + n2;
  const u = rankSum - (n1 * (n1 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = Math.max(0, Math.abs(u - mean) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26; error below 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
