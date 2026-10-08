import { Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { callChannel, channelsOver, follow as followChannel } from "@lemma/client";
import type { ConnectionStatus, Followable, HostRpcClient } from "@lemma/client";
import { HostError } from "@lemma/contracts";
import type { ChannelDeclaration, RuntimeEvent } from "@lemma/contracts";
import { CliError, ExitCode } from "./command.ts";
import type { Failure } from "./command.ts";

/*
 * How commands reach the host's subsystems: through the channels their
 * plugins serve, typed by the declarations in @lemma/contracts
 * (`SessionChannels`, `AgentChannels`, `LlmChannels`, ...). The host's own
 * calls (`Host.*`, `Ui.*`, `Interaction.*`) and its event stream are the
 * runtime's, reached as RPCs. Its streams, the events and the channels', are
 * read only through `@lemma/client` (`eventsOver`, `channelsOver`, `follow`),
 * into the command's own queues (`received`): see `makeHostRpc` for why.
 */

/** Whether `error` is channel `id`'s own `code`: the transport's, naming the channel, rather than what the channel's subsystem refused. */
export const ofChannel = (error: Failure | undefined, id: string, code: string): boolean =>
  (error instanceof HostError || error instanceof CliError) && error.code === code && error.subject === id;

/**
 * `Unavailable` naming what a request named (a channel, an inspector) is the
 * host still starting: its plugins were not up at the transport's startup
 * timeout. It exits 3, as for a host that cannot be reached, where a
 * subsystem's own `Unavailable` names what it concerns (a path) and exits 1.
 */
export const starting =
  (id: string) =>
  (error: Failure): Failure =>
    ofChannel(error, id, "Unavailable") ? new CliError({ code: "Unavailable", message: error.message, subject: id, exit: ExitCode.unavailable }) : error;

/**
 * What a failure of channel `id` means here. The transport names the channel
 * as the subject of what it says about it, where a subsystem names what it
 * refused (a session, a path): so `Unavailable` naming the channel is the
 * host still starting (`starting`). `NotFound` naming it is nothing serving
 * it when the transport says `No channel "<id>"`; otherwise a channel of the
 * other kind answers for the id (a stream called), as its message says.
 * `Withdrawn` naming it is its plugin reloading while it ran: a call the host
 * could not make again for the command (a login, a command, or one nothing
 * answers once the reload finished) or a stream, which the command runs again.
 */
export const refined =
  (id: string) =>
  (error: Failure): Failure => {
    if (ofChannel(error, id, "Unavailable")) return starting(id)(error);
    if (ofChannel(error, id, "NotFound") && error.message === `No channel "${id}"`)
      return new CliError({
        code: "NotFound",
        message: `${error.message}: the plugin that serves it is off or not running (see \`lemma plugins\`)`,
        subject: id,
        exit: ExitCode.failed,
      });
    if (ofChannel(error, id, "Withdrawn"))
      return new CliError({
        code: "Withdrawn",
        message: `"${id}" was withdrawn: the plugin serving it was reloaded or stopped while it ran; run the command again`,
        subject: id,
        exit: ExitCode.failed,
      });
    return error;
  };

/** One call to a channel. */
export const call = <Payload, Success>(
  rpc: HostRpcClient,
  channel: ChannelDeclaration<"call", Payload, Success>,
  payload: Payload,
): Effect.Effect<Success, Failure> => Effect.mapError(callChannel(rpc, channel, payload), refined(channel.id));

/**
 * What a reader of `@lemma/client` hands its callbacks (`open` gives it them
 * and returns its close), as a stream the command reads at its own pace: each
 * element goes into an unbounded queue of the command's at once, since a
 * callback that waited would stall every request on the connection
 * (`makeHostRpc`). It ends as the reader's stream does, failing with what
 * ended it, and is closed with the scope.
 */
export const received = <A>(
  open: (onElement: (element: A) => void, onEnd: (error?: HostError | Error) => void) => () => void,
): Effect.Effect<Stream.Stream<A, Failure>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const elements = yield* Queue.unbounded<A, Failure | Cause.Done>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        open(
          (element) => void Queue.offerUnsafe(elements, element),
          (error) => void (error === undefined ? Queue.endUnsafe(elements) : Queue.failCauseUnsafe(elements, Cause.fail(error as Failure))),
        ),
      ),
      (close) => Effect.sync(close),
    );
    return Stream.fromQueue(elements);
  });

/** A command's subscription to the host's own events (`hostEvents`). */
export interface HostEvents {
  /** Reads it; fails with what ended it. */
  readonly fiber: Fiber.Fiber<void, Failure>;
  /** Hears each event from here on, as it arrives, before the command's own handler takes it in turn: what `follow` opens a stream again on. */
  readonly onEvent: (listener: (event: RuntimeEvent) => void) => () => void;
}

/** A command's connection never comes back once it drops: the command fails instead. */
const CONNECTED: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };

/**
 * A command's WebSocket as `follow` (`@lemma/client`) takes a connection:
 * connected for as long as the command runs, and hearing the host's events
 * the command subscribed to, whose `channels-changed` say when a stream is
 * served again.
 */
export const followable = (rpc: HostRpcClient, events: HostEvents): Followable => ({
  status: () => CONNECTED,
  onStatus: (listener) => {
    listener(CONNECTED);
    return () => {};
  },
  onEvent: events.onEvent,
  channel: channelsOver(rpc),
});

/**
 * Follows a channel's stream with `@lemma/client`'s `follow`, the one reopen
 * policy clients share, for as long as the scope lasts, or until `keep`, told
 * of each ending (nothing when the stream finished), says false: it stops
 * following then.
 */
export const following = <Payload, Success>(
  connection: Followable,
  channel: ChannelDeclaration<"stream", Payload, Success>,
  payload: () => Payload,
  onElement: (element: Success) => void,
  keep: (error: Failure | undefined) => boolean,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(
    Effect.acquireRelease(
      Effect.sync(() => {
        let over = false;
        let stop: (() => void) | undefined;
        stop = followChannel(connection, channel, payload, onElement, (error) => {
          if (keep(error as Failure | undefined)) return;
          over = true;
          stop?.();
        });
        // It ended for good while it was first opened, before `stop` was known.
        if (over) stop();
        return stop;
      }),
      (stop) => Effect.sync(stop),
    ),
  );

/**
 * Forks `run`, which reads a stream, in the scope, and returns its fiber once
 * `run` has handled the first element (and run `handled`). A stream of the
 * host's says with its first element that it hears everything from then on
 * (`subscribed`, or a whole list): what a command does next is heard. One
 * that ends first fails the command: its reason is the host's or the
 * connection's, and one that just ends has nothing to follow.
 */
const subscribed = <R>(name: string, run: (handled: Effect.Effect<void>) => Effect.Effect<void, Failure, R>) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkScoped(run(Effect.asVoid(Deferred.succeed(first, undefined))), { startImmediately: true });
    yield* Effect.raceFirst(
      Deferred.await(first),
      Effect.andThen(
        Fiber.join(fiber),
        Effect.fail(new CliError({ code: "Unexpected", message: `The host ended ${name} before it said it was subscribed`, exit: ExitCode.failed })),
      ),
    );
    return fiber;
  });

/** Reads `stream` in a fiber of the scope, each element to `onElement`, once it is subscribed (see `subscribed`). */
export const subscribe = <A>(name: string, stream: Stream.Stream<A, Failure>, onElement: (element: A) => Effect.Effect<void, Failure>) =>
  subscribed(name, (handled) => Stream.runForEach(stream, (element) => Effect.andThen(onElement(element), handled)));

/**
 * Follows a channel's stream for the command (`following`): opened again at
 * once when withdrawn, with the payload `payload()` gives then, so a follower
 * passes what it has (a log's last `seq`) and resyncs from the new
 * `subscribed`, and once it is listed if nothing serves it then (an exclusive
 * plugin's replacement is listed only once the old one has gone). Its
 * elements are handled in turn, those of each opening after the last's, as
 * `subscribe` does, and this returns once the first has been. The fiber fails
 * with any other ending (the channel's error or the connection's, or nothing
 * serving it before it was ever withdrawn), and ends when the stream does. It
 * is followed for as long as the fiber runs: interrupting it closes the stream.
 */
export const follow = <Payload, Success>(
  connection: Followable,
  channel: ChannelDeclaration<"stream", Payload, Success>,
  payload: () => Payload,
  onElement: (element: Success) => Effect.Effect<void, Failure>,
): Effect.Effect<Fiber.Fiber<void, Failure>, Failure, Scope.Scope> =>
  subscribed(`"${channel.id}"`, (handled) =>
    Effect.scoped(
      Effect.gen(function* () {
        const elements = yield* Queue.unbounded<Success, Failure | Cause.Done>();
        let withdrawn = false;
        yield* following(
          connection,
          channel,
          payload,
          (element) => void Queue.offerUnsafe(elements, element),
          (error) => {
            if (ofChannel(error, channel.id, "Withdrawn")) return (withdrawn = true);
            // Since withdrawn, nothing serving it yet is its replacement on its way.
            if (withdrawn && ofChannel(error, channel.id, "NotFound")) return true;
            if (error === undefined) Queue.endUnsafe(elements);
            else Queue.failCauseUnsafe(elements, Cause.fail(refined(channel.id)(error)));
            return false;
          },
        );
        yield* Stream.runForEach(Stream.fromQueue(elements), (element) => Effect.andThen(onElement(element), handled));
      }),
    ),
  );
