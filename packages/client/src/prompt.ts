import { AgentChannels, HostError } from "@lemma/contracts";
import type { ChannelInfo, PromptContent, TurnOptions, WhenBusy } from "@lemma/contracts";
import type { Host } from "./host.ts";

/** A random request id. `crypto.getRandomValues`, unlike `crypto.randomUUID`, exists outside secure contexts too (a page over plain HTTP). */
export const newRequestId = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** What `startPrompt` uses of a connection: a `Host` has it, as does anything offering its channels and events (the web app's `Client`). */
export interface PromptConnection {
  readonly channel: Pick<Host["channel"], "call" | "open">;
  /** The host's events: a `channels-changed` listing the agent's channels says a withdrawn prompt can be sent again. */
  readonly onEvent: (listener: (event: { readonly type: string; readonly channels?: readonly ChannelInfo[] }) => void) => () => void;
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

/** The agent's channels a prompt uses: sent again once both answer. */
const AGENT = [AgentChannels.prompt.id, AgentChannels.activity.id];
/** How long a withdrawn prompt waits for the agent's replacement to answer before it fails (ms). */
const ANSWER_MS = 30_000;

const codeOf = (error: unknown): string | undefined => (error instanceof HostError ? error.code : undefined);

/** Hears, from now on, each `channels-changed` that lists every one of `ids`. */
const watchChannels = (connection: PromptConnection, ids: readonly string[]) => {
  let heard = false;
  let wake: (() => void) | undefined;
  const stop = connection.onEvent((event) => {
    if (event.type !== "channels-changed" || !ids.every((id) => event.channels?.some((channel) => channel.id === id) === true)) return;
    heard = true;
    wake?.();
  });
  return {
    /** True once they are listed since the last call (at once if they were meanwhile); false when `ms` passes first. */
    listed: (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (heard) {
          heard = false;
          return resolve(true);
        }
        const timer = setTimeout(() => {
          wake = undefined;
          resolve(false);
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          heard = false;
          resolve(true);
        };
      }),
    stop,
  };
};

/**
 * Sends a prompt and reports acceptance separately from completion.
 * `agent.prompt` answers only when the turn that places the prompt ends, and
 * a refusal fails it before the agent takes it. So `agent.activity` is opened
 * first, and the prompt sent once it is subscribed: the prompt counts as
 * accepted at the first sign there that the agent took it, `turn-started` for
 * the session or its id in a `queue-changed`, or when `done` resolves if
 * those (losable) elements never arrive. The stream is closed once it is.
 *
 * When the agent stops or is replaced while the call waits, the call ends
 * `Withdrawn` and is made again with the same `requestId`, which waits for
 * the prompt's turn, or places the prompt if it never was, and never places it
 * twice: at once, since a replacement may answer already, and else once a
 * `channels-changed` lists the agent's channels again (within 30s).
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
  /** The open `agent.activity`'s close: it is open only until the prompt is taken. */
  let close: (() => void) | undefined;
  const stopListening = () => {
    close?.();
    close = undefined;
  };
  let taken = false;
  let resolveTaken!: () => void;
  const accepted = new Promise<void>((resolve) => (resolveTaken = resolve));
  const accept = () => {
    taken = true;
    stopListening();
    resolveTaken();
  };
  /** Opens `agent.activity` afresh, unless the prompt was taken already; resolves once it is subscribed, rejects if it ends before. */
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      stopListening();
      if (taken) return resolve();
      close = connection.channel.open(
        AgentChannels.activity,
        undefined,
        (activity) => {
          if (activity.type === "subscribed") resolve();
          else if (activity.type === "turn-started" && activity.sessionId === sessionId) accept();
          else if (activity.type === "queue-changed" && activity.sessionId === sessionId && activity.queue.some((queued) => queued.requestId === requestId))
            accept();
        },
        (error) => reject(error ?? new Error(`"${AgentChannels.activity.id}" ended before it was subscribed`)),
      );
    });
  const done = (async () => {
    let watching: ReturnType<typeof watchChannels> | undefined;
    try {
      for (;;) {
        try {
          await listen();
          await connection.channel.call(AgentChannels.prompt, payload);
          return;
        } catch (error) {
          const code = codeOf(error);
          if (code === "Retracted") return;
          // Withdrawn: what answers for the agent now may take it at once. Not found yet: the replacement is listed
          // only once the agent it replaces has gone.
          if (code === "Withdrawn") watching ??= watchChannels(connection, AGENT);
          else if (code !== "NotFound" || watching === undefined || !(await watching.listed(ANSWER_MS))) throw error;
        }
      }
    } finally {
      watching?.stop();
      stopListening();
    }
  })();
  return { requestId, accepted: Promise.race([accepted, done]), done };
}
