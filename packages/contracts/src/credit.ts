import { Schema } from "effect";
import type { HandlerStep } from "@lemma/core";

/*
 * Credit: who shaped what an operation produced, as a log keeps it beside the result. A domain records it where its
 * results are durable (the agent's requests and tool results), so a trajectory can say which plugin changed what, long
 * after the trace that saw it happen is gone.
 */

/** A hook handler's part in a result (`HandlerStep`, kept): its plugin, its own time, and what it changed. */
export const HandlerCredit = Schema.Struct({
  /** The plugin. */
  source: Schema.String,
  /** Its own time, without the rest of the chain, in milliseconds. */
  ms: Schema.Number,
  /** What it changed, a few words each (`+section skills`, `model a → b`, `input`): none when it passed things on as they were. */
  changed: Schema.optional(Schema.Array(Schema.String)),
  /** It answered itself, without the rest of the chain. */
  answered: Schema.optional(Schema.Boolean),
  failed: Schema.optional(Schema.Boolean),
});
export type HandlerCredit = typeof HandlerCredit.Type;

/** A check a result passed or was stopped by on its way (a tool call's guard). */
export const CheckCredit = Schema.Struct({
  source: Schema.String,
  allowed: Schema.Boolean,
  ms: Schema.Number,
  /** Why it stopped it. */
  reason: Schema.optional(Schema.String),
});
export type CheckCredit = typeof CheckCredit.Type;

/** Who shaped a result before it was kept: the handlers around the operation, the checks on its way, and a cut. */
export const ResultCredit = Schema.Struct({
  handlers: Schema.optional(Schema.Array(HandlerCredit)),
  checks: Schema.optional(Schema.Array(CheckCredit)),
  /** Its text was cut from `from` characters to `to`. */
  cut: Schema.optional(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
});
export type ResultCredit = typeof ResultCredit.Type;

/** `step` as credit, with what `changed` says it changed; its milliseconds rounded to hundredths. */
export const creditOf = <I, O>(step: HandlerStep<I, O>, changed: readonly string[]): HandlerCredit => ({
  source: step.pluginId,
  ms: Math.round(step.selfMs * 100) / 100,
  ...(changed.length === 0 ? {} : { changed }),
  ...(step.next === undefined && step.exit === "success" ? { answered: true } : {}),
  ...(step.exit === "success" ? {} : { failed: true }),
});

/** The steps an invocation heard (`onStep`, innermost first) in the order their handlers ran. */
export const inChainOrder = <S extends { readonly index: number }>(steps: readonly S[]): S[] => [...steps].sort((a, b) => a.index - b.index);
