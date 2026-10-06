import type { PromptContent, TurnOptions, WhenBusy } from "@lemma/contracts";
import type { Host } from "./host.ts";

/** A random request id. `crypto.getRandomValues`, unlike `crypto.randomUUID`, exists outside secure contexts too (a page over plain HTTP). */
export const newRequestId = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

export interface StartedPrompt {
  /** The submission's id: sending again with it (after a lost connection, say) cannot place the prompt twice. */
  readonly requestId: string;
  /**
   * Resolves once the agent has taken the prompt (its turn started, or it
   * was queued or placed in the running turn), rejects when the prompt is
   * refused (`Busy`, no model, the session is gone). A client clears its
   * input only after this resolves.
   */
  readonly accepted: Promise<void>;
  /** Settles when the turn that placed it ends, as `Host.agent.prompt` does. */
  readonly done: Promise<void>;
}

/**
 * Sends a prompt and reports acceptance separately from completion.
 * `Agent.Prompt` only returns when the turn that places the prompt ends; a
 * refusal fails it before the agent takes it. So the prompt counts as
 * accepted at the first sign the agent took it: `turn-started` for the
 * session, its id in a `queue-changed`, or its message in the log; or when
 * `done` resolves if those (losable) events never arrived.
 */
export function startPrompt(
  host: Pick<Host, "agent" | "onEvent">,
  sessionId: string,
  content: PromptContent,
  options?: TurnOptions,
  submit: { readonly requestId?: string; readonly whenBusy?: WhenBusy } = {},
): StartedPrompt {
  const requestId = submit.requestId ?? newRequestId();
  let stop = () => {};
  const started = new Promise<void>((resolve) => {
    stop = host.onEvent((event) => {
      if (event.type === "turn-started" && event.sessionId === sessionId) resolve();
      else if (event.type === "queue-changed" && event.sessionId === sessionId && event.queue.some((queued) => queued.requestId === requestId)) resolve();
      else if (
        event.type === "session-appended" &&
        event.sessionId === sessionId &&
        event.event.data.type === "message" &&
        event.event.data.requestId === requestId
      )
        resolve();
    });
  });
  const done = host.agent.prompt(sessionId, content, options, { requestId, ...(submit.whenBusy === undefined ? {} : { whenBusy: submit.whenBusy }) });
  const accepted = Promise.race([started, done]);
  void accepted.then(stop, stop);
  return { requestId, accepted, done };
}
