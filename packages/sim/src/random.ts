import type { Random } from "effect";
import type { IdSource } from "@lemma/contracts";

/** FNV-1a: a label's 32-bit hash, to seed a part's own source from the run's seed. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return value >>> 0;
};

/**
 * The seeded source a simulation draws every decision from: mulberry32, as `SimDisk`'s. Each part of the simulation
 * draws from a source of its own (`split`), so a change in how often one part draws leaves the others' draws, and a
 * failing seed's run, as they were.
 */
export class Prng {
  readonly seed: number;
  private state: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** A draw from [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer from [0, `count`). */
  int(count: number): number {
    return Math.floor(this.next() * count);
  }

  /** An integer from [`min`, `max`]. */
  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<A>(items: readonly A[]): A {
    if (items.length === 0) throw new Error("Nothing to pick from");
    return items[this.int(items.length)]!;
  }

  /** A source for the part named `label`, from this one's seed alone. */
  split(label: string): Prng {
    return new Prng(hash(`${this.seed}:${label}`));
  }

  /** Random bytes for ids, from this source. */
  ids(): IdSource {
    return (size) => Uint8Array.from({ length: size }, () => this.int(256));
  }

  /** Effect's `Random`, drawing from this source. */
  effect(): Random.Random {
    return {
      nextIntUnsafe: () => Math.floor(this.next() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) + Number.MIN_SAFE_INTEGER,
      nextDoubleUnsafe: () => this.next(),
    };
  }

  /**
   * Swarm testing's weights: a random non-empty subset of `kinds` is on, each with a weight from 1 to 100, the rest off.
   * Drawn once per run, so each run explores its own mix, rather than every run the same uniform one.
   */
  swarm<K extends string>(kinds: readonly K[]): Readonly<Record<K, number>> {
    const on = this.between(1, kinds.length);
    const chosen = new Set<K>();
    // Each kind in turn, taken with the chance that leaves `on` of them taken in all.
    for (let index = 0; index < kinds.length && chosen.size < on; index++) {
      if (this.chance((on - chosen.size) / (kinds.length - index))) chosen.add(kinds[index]!);
    }
    return Object.fromEntries(kinds.map((kind) => [kind, chosen.has(kind) ? this.between(1, 100) : 0])) as Record<K, number>;
  }

  /** One of the kinds `weights` has on, drawn by weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K | undefined {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total === 0) return undefined;
    let draw = this.next() * total;
    for (const [kind, weight] of entries) {
      draw -= weight;
      if (draw < 0) return kind;
    }
    // Rounding left the draw past the end: the last kind that is on.
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index]![1] > 0) return entries[index]![0];
    return undefined;
  }
}
