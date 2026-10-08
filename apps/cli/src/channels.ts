import { Deferred, Duration, Effect, Fiber, Stream } from "effect";
import type { Scope } from "effect";
import { callChannel, openChannel } from "@lemma/client";
import type { HostRpcClient } from "@lemma/client";
import { HostError } from "@lemma/contracts";
import type { ChannelDeclaration } from "@lemma/contracts";
import { CliError, ExitCode } from "./command.ts";
import type { Failure } from "./command.ts";

/*
 * How commands reach the host's subsystems: through the channels their
 * plugins serve, typed by the declarations in @lemma/contracts
 * (`SessionChannels`, `AgentChannels`, `LlmChannels`, ...). The host's own
 * calls (`Host.*`, `Ui.*`, `Interaction.*`) and its event stream are the
 * runtime's, reached as RPCs.
 */

/** Whether `error` is channel `id`'s own `code`: the transport's, naming the channel, rather than what the channel's subsystem refused. */
export const ofChannel = (error: Failure, id: string, code: string): boolean =>
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
    return error;
  };

/** One call to a channel. */
export const call = <Payload, Success>(
  rpc: HostRpcClient,
  channel: ChannelDeclaration<"call", Payload, Success>,
  payload: Payload,
): Effect.Effect<Success, Failure> => Effect.mapError(callChannel(rpc, channel, payload), refined(channel.id));

/** A channel's stream, opened once. */
export const open = <Payload, Success>(
  rpc: HostRpcClient,
  channel: ChannelDeclaration<"stream", Payload, Success>,
  payload: Payload,
): Stream.Stream<Success, Failure> => Stream.mapError(openChannel(rpc, channel, payload), refined(channel.id));

/** How long what its plugin's leaving withdrew waits for the channel to be served again: that plugin's dispose deadline (10 seconds by default), then its replacement's start. */
const REPLACEMENT = Duration.seconds(30);
const POLL = Duration.millis(200);

/** Waits until `Channel.List` lists `id`, until `deadline` (epoch ms): whether it did. */
export const served = (rpc: HostRpcClient, id: string, deadline: number): Effect.Effect<boolean, Failure> =>
  Effect.gen(function* () {
    for (;;) {
      if ((yield* rpc["Channel.List"]()).some((channel) => channel.id === id)) return true;
      if (Date.now() >= deadline) return false;
      yield* Effect.sleep(POLL);
    }
  });

/**
 * Runs `attempt`, which calls or follows channel `id`, again each time it
 * fails `Withdrawn`: its plugin stopped or was replaced (a reload) while it
 * waited, so it is made again once the channel is served. An exclusive
 * plugin's replacement is listed only once the old one has gone, and until
 * then a call finds nothing (`NotFound`): it waits for the channel to be
 * listed, for at most `REPLACEMENT`, then fails with the withdrawal.
 *
 * For what is safe to make twice: a call that waits on its plugin (a
 * prompt, a login, a command), or a stream.
 */
export const again = <A, R>(rpc: HostRpcClient, id: string, attempt: Effect.Effect<A, Failure, R>): Effect.Effect<A, Failure, R> =>
  Effect.gen(function* () {
    let withdrawn: Failure | undefined;
    for (;;) {
      const result = yield* Effect.result(attempt);
      if (result._tag === "Success") return result.success;
      const error = result.failure;
      if (ofChannel(error, id, "Withdrawn")) withdrawn = error;
      else if (withdrawn === undefined || !ofChannel(error, id, "NotFound")) return yield* Effect.fail(error);
      if (!(yield* served(rpc, id, Date.now() + Duration.toMillis(REPLACEMENT)))) return yield* Effect.fail(withdrawn);
    }
  });

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
 * Follows a channel's stream as `subscribe` reads one, opening it again
 * (`again`) when it ends `Withdrawn`, with the payload `payload()` gives
 * then: a follower passes what it has (a log's last `seq`) and resyncs from
 * the new `subscribed`. The fiber fails with whatever else ends it.
 */
export const follow = <Payload, Success>(
  rpc: HostRpcClient,
  channel: ChannelDeclaration<"stream", Payload, Success>,
  payload: () => Payload,
  onElement: (element: Success) => Effect.Effect<void, Failure>,
): Effect.Effect<Fiber.Fiber<void, Failure>, Failure, Scope.Scope> =>
  subscribed(`"${channel.id}"`, (handled) =>
    again(
      rpc,
      channel.id,
      Stream.runForEach(
        Stream.suspend(() => open(rpc, channel, payload())),
        (element) => Effect.andThen(onElement(element), handled),
      ),
    ),
  );
