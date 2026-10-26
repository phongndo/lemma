import { Cause } from "effect";
import { AgentError } from "../agent.ts";

/** A failure of another capability (the log, the models) as the agent reports it: its message, with it as the cause. */
export const failedAs =
  (sessionId: string, reason: AgentError["reason"]) =>
  (error: { readonly message: string }): AgentError =>
    new AgentError({ sessionId, reason, message: error.message, cause: error });

/** `error` is the core's `CoreClosed`, or wraps one (as a hook failure the turn reports does). */
export const isCoreClosed = (error: unknown, depth = 0): boolean =>
  typeof error === "object" &&
  error !== null &&
  depth < 8 &&
  ((error as { readonly _tag?: unknown })._tag === "CoreClosed" || ("cause" in error && isCoreClosed(error.cause, depth + 1)));

/** The turn failed because the core is shutting down. */
export const closedCore = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => (Cause.isFailReason(reason) && isCoreClosed(reason.error)) || (Cause.isDieReason(reason) && isCoreClosed(reason.defect)));

/** What a turn that failed says of why: its failure's message. */
export const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};
