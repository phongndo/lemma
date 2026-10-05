import { NATIVE_HARNESS } from "@lemma/contracts";
import type { HarnessInfo, TurnOptions } from "@lemma/contracts";

/** A harness picked for a thread's next prompt, over the one the thread was on: it lapses once the thread moves. */
export interface HarnessPick {
  readonly harness: string;
  readonly over: string | undefined;
}

/** The pick, while the thread is still on the harness it was made over. */
export const activePick = (pick: HarnessPick | undefined, current: string | undefined): string | undefined =>
  pick !== undefined && pick.over === current ? pick.harness : undefined;

/**
 * The harness new threads start on: the stored one while it is listed and
 * ready, else the native harness, so the composer shows what a turn will run
 * on. Before the list loads, the stored one.
 */
export const resolveHarness = (harnesses: readonly HarnessInfo[], stored: string | undefined): string => {
  if (stored === undefined) return NATIVE_HARNESS;
  if (harnesses.length === 0) return stored;
  return harnesses.some((harness) => harness.id === stored && harness.status.state === "ready") ? stored : NATIVE_HARNESS;
};

export interface NextHarness {
  /** The harness the next prompt runs on. */
  readonly id: string;
  /** The harness its options name (`TurnOptions.harness`); undefined leaves the choice to the host. */
  readonly name: string | undefined;
}

/**
 * The harness of the active thread's next prompt. A thread stays on its last
 * turn's harness (`current`), which the host keeps without being told, so it
 * names one only when another was picked; a new thread, or one without turns,
 * starts on `preferred` and names it. While the thread's log loads its harness
 * is unknown, so only a pick is named.
 */
export const nextHarness = (state: {
  readonly current: string | undefined;
  readonly picked: string | undefined;
  readonly preferred: string;
  readonly loading: boolean;
}): NextHarness => {
  const id = state.picked ?? state.current ?? state.preferred;
  if (state.loading) return { id, name: state.picked };
  if (state.current === undefined) return { id, name: id };
  return { id, name: state.picked !== undefined && state.picked !== state.current ? state.picked : undefined };
};

/**
 * A prompt's options: the model's, naming `name` when given, and without the
 * model and reasoning when `harness` runs on a model of its own.
 */
export const withHarness = (options: TurnOptions | undefined, name: string | undefined, harness: HarnessInfo | undefined): TurnOptions | undefined => {
  const next: TurnOptions = { ...(harness?.capabilities.models === false ? {} : options), ...(name === undefined ? {} : { harness: name }) };
  return Object.keys(next).length === 0 ? undefined : next;
};
