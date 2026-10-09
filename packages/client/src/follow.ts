import { HostError } from "@lemma/contracts/runtime";
import type { ChannelDeclaration } from "@lemma/contracts/runtime";
import { safely } from "./host.ts";
import type { Host } from "./host.ts";

/**
 * What `follow` uses of a connection: its status, its `channels-changed`
 * events, and opening a stream. A `Host` is one (the web app's and the
 * CLI's); so is a test's fake.
 */
export type Followable = Pick<Host, "status" | "onStatus" | "onEvent"> & { readonly channel: Pick<Host["channel"], "open"> };

type StreamEnd = (error?: HostError | Error) => void;

/**
 * Keeps a channel stream open until the returned close: opened now if
 * connected, and anew on every new connection (a status `generation`), since
 * a stream ends with its connection; again at once when it ends `Withdrawn`,
 * its plugin stopped or replaced; and, after it ended otherwise (nothing
 * served it, say), when a `channels-changed` lists it, or at once if one
 * listed it while that opening was on its way, before the stream sent
 * anything: such a listing crossed the opening's failure. Each opening starts
 * afresh, so a subsystem's stream begins with `subscribed`, from which its
 * reader resyncs. `payload` may be a function, read at each opening
 * (`sessions.log` resumes `after` the last event its reader has). `onEnd`
 * hears each ending; closing from it stops following.
 *
 * The one reopen policy every client of a host's streams shares: the web
 * app's `Client.follow`, and the CLI's.
 */
export function follow<Payload, Success>(
  connection: Followable,
  channel: ChannelDeclaration<"stream", Payload, Success>,
  payload: Payload | (() => Payload),
  onElement: (element: Success) => void,
  onEnd?: StreamEnd,
): () => void;
export function follow(connection: Followable, id: string, payload: unknown, onElement: (element: unknown) => void, onEnd?: StreamEnd): () => void;
export function follow(
  connection: Followable,
  target: string | ChannelDeclaration,
  payload: unknown,
  onElement: (element: any) => void,
  onEnd?: StreamEnd,
): () => void {
  const id = typeof target === "string" ? target : target.id;
  const what = `Channel "${id}" listener failed`;
  /** The open stream's close, while one is open. */
  let current: (() => void) | undefined;
  /** The open stream has sent nothing yet, so it may still fail for want of a channel. */
  let pending = false;
  /** A `channels-changed` listed it while the open was pending: one that then fails crossed that listing, and opens again. */
  let listed = false;
  let stopped = false;
  /** The connection it last opened on: a new one opens it anew. */
  let generation: number | undefined;
  const open = () => {
    current?.();
    current = undefined;
    listed = false;
    if (stopped || connection.status().state !== "connected") return;
    let live = true;
    pending = true;
    const close = connection.channel.open(
      target as string,
      typeof payload === "function" ? (payload as () => unknown)() : payload,
      (element) => {
        if (!live) return;
        pending = false;
        listed = false;
        safely(onElement, element, what);
      },
      (error) => {
        if (!live) return;
        live = false;
        current = undefined;
        if (onEnd !== undefined) safely(onEnd, error, what);
        // Its plugin left: whatever answers for it now, at once. Listed while this open was on its way (an exclusive
        // replacement listed as nothing served the open): at once too. Else `channels-changed` says when one does.
        if ((error instanceof HostError && error.code === "Withdrawn") || listed) open();
      },
    );
    if (live)
      current = () => {
        live = false;
        close();
      };
  };
  const stops: (() => void)[] = [];
  const stop = () => {
    stopped = true;
    current?.();
    current = undefined;
    for (const each of stops.splice(0)) each();
  };
  stops.push(
    connection.onEvent((event) => {
      if (event.type !== "channels-changed" || !event.channels.some((channel) => channel.id === id)) return;
      if (current === undefined) open();
      else if (pending) listed = true;
    }),
  );
  // Called at once with the status now: opened here if connected.
  stops.push(
    connection.onStatus((status) => {
      if (status.state !== "connected" || status.generation === generation) return;
      generation = status.generation;
      open();
    }),
  );
  return stop;
}
