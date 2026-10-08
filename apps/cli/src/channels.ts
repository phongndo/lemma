import { Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { RpcClientError } from "effect/rpc";
import { callChannel, connect, follow as followChannel } from "@lemma/client";
import type { ConnectOptions, ConnectionStatus, Followable, Host, HostRpcClient } from "@lemma/client";
import { HostError } from "@lemma/contracts";
import type { ChannelDeclaration } from "@lemma/contracts";
import { CliError, ExitCode } from "./command.ts";
import type { Failure, Io } from "./command.ts";

/*
 * How commands reach the host's subsystems: through the channels their
 * plugins serve, typed by the declarations in @lemma/contracts
 * (`SessionChannels`, `AgentChannels`, `LlmChannels`, ...). The host's own
 * calls (`Host.*`, `Ui.*`, `Interaction.*`) and its event stream are the
 * runtime's, reached as RPCs. A one-shot command calls over HTTP (`call`); a
 * command that watches the host does so over `@lemma/client`'s `Host`
 * (`openHost`), the reconnecting WebSocket the web app has, and reads its
 * events and streams into the command's own queues (`received`, `follow`):
 * see `makeHostRpc` there for why they are read no other way.
 */

/** Whether `error` is channel `id`'s own `code`: the transport's, naming the channel, rather than what the channel's subsystem refused. */
export const ofChannel = (error: unknown, id: string, code: string): boolean =>
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

/** One call to a channel over HTTP, for a one-shot command. */
export const call = <Payload, Success>(
  rpc: HostRpcClient,
  channel: ChannelDeclaration<"call", Payload, Success>,
  payload: Payload,
): Effect.Effect<Success, Failure> => Effect.mapError(callChannel(rpc, channel, payload), refined(channel.id));

/**
 * Whether a request over a `Host` ended because its connection dropped, as
 * `@lemma/client` says it: with the RPC client's error. One the client could
 * not read (`RpcClientDefect`: a host on another protocol, say) leaves the
 * connection up.
 */
export const dropped = (error: unknown): boolean => error instanceof RpcClientError.RpcClientError && error.reason._tag !== "RpcClientDefect";

/** What a `Host` rejects with, as a command fails: its refusals and the connection's failures, else a defect (a host handler that died). */
const failure = (error: HostError | Error): Cause.Cause<Failure> =>
  error instanceof HostError || error instanceof RpcClientError.RpcClientError ? Cause.fail(error) : Cause.die(error);

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
          (error) => void (error === undefined ? Queue.endUnsafe(elements) : Queue.failCauseUnsafe(elements, failure(error))),
        ),
      ),
      (close) => Effect.sync(close),
    );
    return Stream.fromQueue(elements);
  });

/** The first status of `host`, from the one it has now on, that `found` accepts. */
const statusWhere = (host: Host, found: (status: ConnectionStatus) => boolean): Effect.Effect<ConnectionStatus> =>
  Effect.callback<ConnectionStatus>((resume) => {
    let stop: (() => void) | undefined;
    let done = false;
    stop = host.onStatus((status) => {
      if (done || !found(status)) return;
      done = true;
      stop?.();
      resume(Effect.succeed(status));
    });
    // Found at once, before `stop` was known.
    if (done) stop();
    return Effect.sync(stop);
  });

/**
 * `@lemma/client`'s `Host` for a command that watches the host, once it is
 * connected; it closes with the scope. A first attempt that fails fails the
 * command at once, as a one-shot call would: `Host.Info` over HTTP (`rpc`)
 * says why in the same terms (no host there, a rejected token), which a
 * WebSocket's failure does not, and the socket's own reason is the last word
 * when HTTP answers. Once connected, it reconnects by itself: see
 * `reconnecting`.
 */
export const openHost = (options: ConnectOptions, rpc: Pick<HostRpcClient, "Host.Info">): Effect.Effect<Host, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      Effect.promise(() => connect(options)),
      (host) => Effect.promise(() => host.close()),
    );
    const first = yield* statusWhere(host, (status) => status.state === "connected" || status.attempts > 0);
    if (first.state === "connected") return host;
    yield* rpc["Host.Info"]();
    return yield* new CliError({
      code: "Unreachable",
      message: `The host answers over HTTP, but not over its WebSocket: ${first.error ?? "no reason given"}`,
      exit: ExitCode.unavailable,
    });
  });

/**
 * Consecutive failed attempts to reconnect after which a command gives up on
 * the host: about a minute with `@lemma/client`'s default backoff, which
 * waits 0.25, 0.5, 1, 2, and 4 seconds, then 5 seconds between attempts, 58
 * seconds before the 16th fails (the drop is the first). Attempts, not time:
 * a laptop that wakes from sleep would find a time bound used up at once.
 */
export const GIVE_UP = 16;

/**
 * Runs `body`, a command that carries on across a dropped connection (`run`,
 * `events`): its streams open again on the next connection (`follow`), and
 * its repeatable calls are made again (`callOn`). It says on stderr when the
 * connection drops and when it is back, and fails `Disconnected` (exit 3) once
 * `GIVE_UP` attempts in a row have failed.
 */
export const reconnecting = <A, R>(host: Host, io: Io, body: Effect.Effect<A, Failure, R>): Effect.Effect<A, Failure, R> =>
  Effect.raceFirst(
    body,
    Effect.callback<never, CliError>((resume) => {
      let down = false;
      let stop: (() => void) | undefined;
      let done = false;
      stop = host.onStatus((status) => {
        if (done) return;
        if (status.state === "connected") {
          if (down) io.err("lemma: reconnected to the host");
          down = false;
        }
        if (status.state !== "reconnecting") return;
        if (!down) io.err("lemma: lost the connection to the host; reconnecting…");
        down = true;
        if (status.attempts < GIVE_UP) return;
        done = true;
        stop?.();
        resume(
          Effect.fail(
            new CliError({
              code: "Disconnected",
              message: `Lost the connection to the host, and ${GIVE_UP} attempts to reconnect, about a minute of trying, failed: ${status.error ?? "no reason given"}`,
              exit: ExitCode.unavailable,
            }),
          ),
        );
      });
      if (done) stop();
      return Effect.sync(stop);
    }),
  );

/**
 * One call to a channel over a command's `Host`. When the connection drops
 * while it waits, a call declared `repeatable` is made again once the
 * connection is back, as the host makes it again when its plugin reloads: it
 * has the same effect made once or twice. The wait is `reconnecting`'s to
 * bound. Any other call fails `Disconnected`, since it may or may not have
 * taken effect: whether to run the command again is the person's call.
 */
export const callOn = <Payload, Success>(
  host: Host,
  channel: ChannelDeclaration<"call", Payload, Success>,
  payload: Payload,
): Effect.Effect<Success, Failure> =>
  Effect.suspend(() => {
    const { generation } = host.status();
    return Effect.tryPromise({ try: () => host.channel.call(channel, payload), catch: (error) => error as HostError | Error }).pipe(
      Effect.catch((error) => {
        if (!dropped(error)) return Effect.mapError(Effect.failCause(failure(error)), refined(channel.id));
        if (channel.repeatable !== true)
          return Effect.fail(
            new CliError({
              code: "Disconnected",
              message: `"${channel.id}" was cut off: the connection to the host dropped while it ran; run the command again`,
              subject: channel.id,
              exit: ExitCode.unavailable,
            }),
          );
        return Effect.andThen(
          statusWhere(host, (status) => status.state === "connected" && status.generation > generation),
          callOn(host, channel, payload),
        );
      }),
    );
  });

/** How a command calls channels: over HTTP (`over`) when it makes a call or two, or over its `Host` (`on`) when it watches the host. */
export type Calls = <Payload, Success>(channel: ChannelDeclaration<"call", Payload, Success>, payload: Payload) => Effect.Effect<Success, Failure>;

export const over =
  (rpc: HostRpcClient): Calls =>
  (channel, payload) =>
    call(rpc, channel, payload);

export const on =
  (host: Host): Calls =>
  (channel, payload) =>
    callOn(host, channel, payload);

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
  keep: (error: HostError | Error | undefined) => boolean,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(
    Effect.acquireRelease(
      Effect.sync(() => {
        let over = false;
        let stop: (() => void) | undefined;
        stop = followChannel(connection, channel, payload, onElement, (error) => {
          if (keep(error)) return;
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

/**
 * Follows a channel's stream over a command's `Host` (`following`): opened
 * again on the next connection when the connection drops, and at once when
 * withdrawn, with the payload `payload()` gives then, so a follower passes
 * what it has (a log's last `seq`) and resyncs from the new `subscribed`, and
 * once it is listed if nothing serves it then (an exclusive plugin's
 * replacement is listed only once the old one has gone). Its elements are
 * handled in turn, those of each opening after the last's, as they came, and
 * this returns once the first has been. The fiber fails with any other ending
 * (the channel's error, or nothing serving it before it was ever withdrawn),
 * and ends when the stream does. It is followed for as long as the fiber
 * runs: interrupting it closes the stream.
 */
export const follow = <Payload, Success>(
  host: Host,
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
          host,
          channel,
          payload,
          (element) => void Queue.offerUnsafe(elements, element),
          (error) => {
            if (dropped(error)) return true;
            if (ofChannel(error, channel.id, "Withdrawn")) return (withdrawn = true);
            // Since withdrawn, nothing serving it yet is its replacement on its way.
            if (withdrawn && ofChannel(error, channel.id, "NotFound")) return true;
            if (error === undefined) Queue.endUnsafe(elements);
            else Queue.failCauseUnsafe(elements, Cause.map(failure(error), refined(channel.id)));
            return false;
          },
        );
        yield* Stream.runForEach(Stream.fromQueue(elements), (element) => Effect.andThen(onElement(element), handled));
      }),
    ),
  );
