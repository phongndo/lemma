import type { PhaseOptions } from "../hooks.ts";

/** Throws at the token's declaration when its phases cannot order anything: none, one twice, or no default among them. */
export function checkPhases(kind: string, name: string, options: PhaseOptions): void {
  const { phases, defaultPhase } = options;
  if (phases === undefined) {
    if (defaultPhase !== undefined) throw new Error(`${kind} "${name}" has a default phase but no phases`);
    return;
  }
  if (phases.length === 0) throw new Error(`${kind} "${name}" declares phases, but none`);
  if (new Set(phases).size !== phases.length) throw new Error(`${kind} "${name}" names a phase twice: ${phases.join(", ")}`);
  if (defaultPhase === undefined || !phases.includes(defaultPhase)) {
    throw new Error(`${kind} "${name}" needs a default phase among its phases (${phases.join(", ")})`);
  }
}

/** Where a contribution asking for `phase` goes in a token declaring `declared`: its phase and rank, or why it cannot. */
export function placeIn(declared: PhaseOptions, phase: string | undefined): { readonly phase?: string; readonly rank: number } | string {
  if (declared.phases === undefined) return phase === undefined ? { rank: 0 } : `has no phases, so none is "${phase}"`;
  const chosen = phase ?? declared.defaultPhase!;
  const rank = declared.phases.indexOf(chosen);
  return rank === -1 ? `has no phase "${chosen}": its phases are ${declared.phases.join(", ")}` : { phase: chosen, rank };
}
