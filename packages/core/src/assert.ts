import { Context } from "effect";

/** A broken invariant: a bug, never an expected failure. */
export class AssertionError extends Error {
  override readonly name = "AssertionError";
}

/**
 * Checks what must hold where it is used: an argument, a result, an invariant between two states. It stays on in
 * production. A broken one is a bug, and stopping where it broke is better than going on with corrupt state: thrown
 * in an Effect it is a defect, which the kernel reports as the fault of the plugin whose work broke it. Assert a fact
 * in two places when it crosses a boundary (before a write and after reading it back), and an implication as
 * `if (a) assert(b, …)`.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

/**
 * Whether to run the checks too costly for every call: rebuilding from scratch what was kept incrementally, comparing a
 * whole log with what was served from it. Off by default; a simulation turns it on. A runtime setting (as Effect's
 * `Clock` is): the core passes it on to every plugin's work.
 */
export const Verify = Context.Reference<boolean>("lemma/core/Verify", { defaultValue: () => false });
