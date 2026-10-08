/*
 * Sending a prompt over the agent's channels: `@lemma/client/prompt`. An entry
 * of its own, since the main one is the connection the web app's runtime
 * imports, which reaches no domain contract (scripts/check-boundaries.ts).
 */

import { AgentChannels, HostError } from "@lemma/contracts";
import type { ChannelDeclaration, PromptContent, TurnOptions, WhenBusy } from "@lemma/contracts";
import type { Host } from "./host.ts";

/** A random request id. `crypto.getRandomValues`, unlike `crypto.randomUUID`, exists outside secure contexts too (a page over plain HTTP). */
export const newRequestId = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * What `startPrompt` uses of a connection: the web app's `Client` has it, and
 * over a `Host`, `follow` is `@lemma/client`'s bound to it
 * (`(...args) => follow(host, ...args)`).
 */
export interface PromptConnection {
  /** Keeps `agent.activity` open, as `follow` does, to see the prompt taken. */
  readonly follow: <Payload, Success>(
    channel: ChannelDeclaration<"stream", Payload, Success>,
    payload: Payload,
    onElement: (element: Success) => void,
    onEnd?: (error?: HostError | Error) => void,
  ) => () => void;
  /** Calls `agent.prompt` to send it. */
  readonly channel: Pick<Host["channel"], "call">;
}

export interface StartedPrompt {
  /** The submission's id: sending again with it (after a lost connection, say) cannot place the prompt twice. */
  readonly requestId: string;
  /**
   * Resolves once the agent has taken the prompt (its turn started, or it
   * was queued or placed in the running turn), rejects when the prompt is
   * refused (`Busy`, no model, the session is gone, no agent). A client clears
   * its input only after this resolves.
   */
  readonly accepted: Promise<void>;
  /**
   * Settles when the turn that placed it ends, as `agent.prompt` answers;
   * resolves too, quietly, when the prompt was taken out of the queue
   * (`Retracted`), since whoever withdrew it meant to.
   */
  readonly done: Promise<void>;
}

const isWithdrawn = (error: unknown): boolean => error instanceof HostError && error.code === "Withdrawn";

/**
 * Sends a prompt and reports acceptance separately from completion.
 * `agent.prompt` answers only when the turn that places the prompt ends, and
 * a refusal fails it before the agent takes it. So `agent.activity` is
 * followed first, and the prompt sent once it is subscribed: the prompt
 * counts as accepted at the first sign there that the agent took it,
 * `turn-started` for the session or its id in a `queue-changed`, or when
 * `done` resolves if those (losable) elements never arrive. The stream is
 * closed once it is. One that ends before it was first subscribed, other
 * than withdrawn, refuses the prompt unsent (no agent serves it, say).
 *
 * The prompt is sent once. When the agent reloads while it waits, the host
 * makes `agent.prompt` again on the replacement (it is `repeatable`), and
 * `agent.activity`, withdrawn, is followed onto the replacement, where the
 * prompt's acceptance is seen.
 */
export function startPrompt(
  connection: PromptConnection,
  sessionId: string,
  content: PromptContent,
  options?: TurnOptions,
  submit: { readonly requestId?: string; readonly whenBusy?: WhenBusy } = {},
): StartedPrompt {
  const requestId = submit.requestId ?? newRequestId();
  const payload = {
    sessionId,
    content,
    requestId,
    ...(options === undefined ? {} : { options }),
    ...(submit.whenBusy === undefined ? {} : { whenBusy: submit.whenBusy }),
  };
  /** `agent.activity`'s close: it is followed only until the prompt is taken, or settles. */
  let close: (() => void) | undefined;
  let closed = false;
  const stopListening = () => {
    closed = true;
    close?.();
  };
  let resolveTaken!: () => void;
  const accepted = new Promise<void>((resolve) => (resolveTaken = resolve));
  const accept = () => {
    stopListening();
    resolveTaken();
  };
  let listening = false;
  /** Resolves once `agent.activity` is first subscribed; rejects if it ends otherwise than withdrawn before then. */
  const subscribed = new Promise<void>((resolve, reject) => {
    close = connection.follow(
      AgentChannels.activity,
      undefined,
      (activity) => {
        if (activity.type === "subscribed") {
          listening = true;
          resolve();
        } else if (activity.type === "turn-started" && activity.sessionId === sessionId) accept();
        else if (activity.type === "queue-changed" && activity.sessionId === sessionId && activity.queue.some((queued) => queued.requestId === requestId))
          accept();
      },
      (error) => {
        if (!listening && !isWithdrawn(error)) reject(error ?? new Error(`"${AgentChannels.activity.id}" ended before it was subscribed`));
      },
    );
  });
  // Taken, or refused, while it was first opened, before its close was known.
  if (closed) close?.();
  const done = (async () => {
    try {
      await subscribed;
      await connection.channel.call(AgentChannels.prompt, payload);
    } catch (error) {
      if (!(error instanceof HostError && error.code === "Retracted")) throw error;
    } finally {
      stopListening();
    }
  })();
  return { requestId, accepted: Promise.race([accepted, done]), done };
}
