import type { PromptContent } from "@lemma/agent";
import { returned, unsent } from "./drafts.ts";
import type { Draft, Drafts, Prompt } from "./drafts.ts";

/** What sending does while a turn runs: join it after its current step, or wait to go as the next turn. */
export type WhenBusy = "steer" | "follow-up";

/** A prompt going out: what it held, and the request id that makes sending it again unchanged place it once. */
export type Outgoing = Draft & { readonly requestId: string };

/** What the sender works on: the composer's state and the host it sends to, as plain functions. */
export interface SenderHost {
  readonly drafts: Drafts;
  /** Prompts on their way to the host, not yet taken: the composer has cleared, so they are in no draft. */
  readonly outgoing: Set<Draft>;
  /** The open thread's draft key (`""` for a new thread). */
  readonly key: () => string;
  /** What the composer holds now. */
  readonly read: () => Prompt;
  /** Puts a prompt in the composer. */
  readonly write: (prompt: Prompt) => void;
  /** The thread a refused prompt written in `key` returns to: that one, or for a new thread's (`""`), the session placing it created. */
  readonly home: (key: string) => string;
  readonly sending: () => boolean;
  readonly setSending: (sending: boolean) => void;
  readonly connected: () => boolean;
  readonly newRequestId: () => string;
  /** A prompt is about to go out, before the composer clears. */
  readonly starting: () => void;
  /** Places the prompt, in a new thread in the background with `background`: true once the host took it, false (or a throw) when it was refused. */
  readonly place: (prompt: Outgoing, content: PromptContent, whenBusy: WhenBusy, background: boolean) => Promise<boolean>;
  /** Says why placing it threw. */
  readonly report: (error: unknown) => void;
  /** A send has settled, taken or not: the composer may hold something else now. */
  readonly settled: () => void;
}

/** The content a prompt sends: its text, unless only whitespace, then its images. */
export const promptContent = (prompt: Prompt): PromptContent => [
  ...(prompt.text.trim() === "" ? [] : [{ type: "text" as const, text: prompt.text }]),
  ...prompt.images,
];

/**
 * Sends what the composer holds, one prompt at a time. The composer clears as a prompt goes out: what is typed
 * meanwhile is the next prompt, never this one. Until the host takes it, it is outgoing; refused, it returns to the
 * thread it was written in (`home`), ahead of what was typed there since (`returned`). A send asked for while one goes
 * out remembers what the composer held then, and goes once the first is taken, if the composer holds the same still.
 * One `background` goes to a new thread instead of the one shown.
 */
export function createSender(host: SenderHost) {
  let next: (Prompt & { readonly whenBusy: WhenBusy; readonly background: boolean }) | undefined;
  /** Connected, with nothing going out, and something to send. */
  const canSend = () => host.connected() && !host.sending() && unsent(host.read());
  const send = async (whenBusy: WhenBusy, background = false): Promise<void> => {
    if (host.sending()) {
      const held = host.read();
      if (unsent(held)) next = { whenBusy, background, text: held.text, images: held.images };
      return;
    }
    if (!canSend()) return;
    host.starting();
    const held = host.read();
    const content = promptContent(held);
    // Sending a new chat creates a session and switches to it, so remember which draft this was.
    const key = host.key();
    const sent: Outgoing = { text: held.text, images: held.images, requestId: host.drafts.get(key)?.requestId ?? host.newRequestId() };
    host.outgoing.add(sent);
    host.drafts.set(key, undefined);
    host.write({ text: "", images: [] });
    host.setSending(true);
    let ok = false;
    try {
      ok = await host.place(sent, content, whenBusy, background);
    } catch (error) {
      host.report(error);
    }
    host.setSending(false);
    host.outgoing.delete(sent);
    if (!ok) {
      const home = host.home(key);
      const back = returned(sent, host.drafts.get(home));
      host.drafts.set(home, back);
      if (home === host.key()) host.write(back);
    }
    host.settled();
    const queued = next;
    next = undefined;
    if (!ok || queued === undefined) return;
    const now = host.read();
    if (now.text === queued.text && now.images === queued.images) void send(queued.whenBusy, queued.background);
  };
  return { canSend, send };
}
