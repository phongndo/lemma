import { Effect, Queue, Schema, Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { awaitable, isExpectedFailure, Registry } from "@lemma/core";
import type { Awaitable } from "@lemma/core";
import { HostError } from "./status.ts";

export type ChannelKind = "call" | "stream";

/**
 * What a client needs to reach a channel, without its implementation: a
 * contract module declares one, the host plugin serving it adds it with a
 * handler (`serveChannel`), and a client imports the same value to call it
 * typed (`@lemma/client`), or calls it by `id` with plain JSON.
 *
 * What crosses the wire is JSON: payloads and results go through their
 * schema's JSON codec (`Schema.toCodecJson`), so a `Date`, a `BigInt`, or
 * `NaN` arrives as it was sent, and no result (`Schema.Void`) arrives as
 * `null`. A value its codec cannot send, such as an `undefined` field in
 * `Schema.Unknown`, fails that request.
 */
export interface ChannelDeclaration<Kind extends ChannelKind = ChannelKind, Payload = any, Success = any> {
  /** A call answers once; a stream sends elements until it ends. */
  readonly kind: Kind;
  /** Unique across plugins by convention: `<plugin>.<name>` (`ticker.prices`). */
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  /** Decodes what a client sends; a payload it rejects fails `InvalidPayload` before the handler runs. `Schema.Void` takes none. */
  readonly payload: Schema.Codec<Payload, any>;
  /** Encodes a call's result, or each element of a stream, for the wire. */
  readonly success: Schema.Codec<Success, any>;
}

/**
 * Answers once, with its result, a promise of it, or an Effect (`Awaitable`).
 * A domain error it fails with (one with a `_tag`; promise code throws it
 * marked with `fail`) keeps its `reason` or tag as the client's error code;
 * anything else is `Failed`. A call in flight when its plugin stops or is
 * replaced finishes on that instance before the instance's finalizers run, so
 * it may use the plugin's resources to the end; one still running at the
 * dispose deadline is interrupted, and its client gets `Withdrawn`.
 */
export interface ChannelCall<Payload = any, Success = any> extends ChannelDeclaration<"call", Payload, Success> {
  readonly handle: (payload: Payload) => Awaitable<Success, unknown>;
}

/**
 * Sends elements until it ends, fails as a call does, or the client stops it:
 * a Stream, or an async iterable (an `async function*`) from promise code. It
 * is stopped as soon as its plugin stops or is replaced (its client gets
 * `Withdrawn`), and before that plugin's finalizers run.
 *
 * Each open stream is pulled at its own client's pace: a slow client holds
 * its stream back. A stream fed from a source others share must therefore
 * slide or drop for each subscriber, never wait on the source: the ticker
 * example gives each one `SubscriptionRef.changes` behind
 * `Stream.buffer({ capacity: 1, strategy: "sliding" })`. A back-pressured
 * shared `PubSub` would let one stalled client stop the plugin, and with it
 * every other client.
 */
export interface ChannelStream<Payload = any, Success = any> extends ChannelDeclaration<"stream", Payload, Success> {
  readonly handle: (payload: Payload) => Stream.Stream<Success, unknown> | AsyncIterable<Success>;
}

/**
 * A call or a stream a host plugin serves to clients: its own web plugin, a
 * UI file, a script, or the CLI (`lemma channels`). The transport serves every
 * channel through `ChannelRpcs`, so a plugin offers its own data without a
 * change to these contracts or the transport. A plugin adds one to `Channels`
 * with `PluginContext.add`; it belongs to that plugin and leaves with it,
 * which ends its open streams. Nothing has to provide anything for it to be
 * added.
 */
export type Channel = ChannelCall | ChannelStream;

/** A declaration typed by its schemas: `const prices = defineChannel({ kind: "stream", id: "ticker.prices", … })`. */
export const defineChannel = <const Kind extends ChannelKind, Payload, Success>(
  declaration: ChannelDeclaration<Kind, Payload, Success>,
): ChannelDeclaration<Kind, Payload, Success> => declaration;

/** What serves a channel of `Kind`: the `handle` of a `ChannelCall` or a `ChannelStream`. */
export type ChannelHandler<Kind extends ChannelKind, Payload, Success> = Kind extends "call"
  ? ChannelCall<Payload, Success>["handle"]
  : ChannelStream<Payload, Success>["handle"];

/**
 * A declaration with the handler that serves it, typed by its schemas: what a
 * host plugin adds, `owner.add(Channels, serveChannel(prices, () => quotes))`.
 * A plugin file without types may add the object itself, `{ ...declaration, handle }`.
 */
export const serveChannel = <const Kind extends ChannelKind, Payload, Success>(
  declaration: ChannelDeclaration<Kind, Payload, Success>,
  handle: ChannelHandler<Kind, Payload, Success>,
): Extract<Channel, { readonly kind: Kind }> => ({ ...declaration, handle }) as unknown as Extract<Channel, { readonly kind: Kind }>;

/**
 * What a stream that reports a subsystem's changes sends each client who opens
 * it: `first`, then what `sources` send, in order within each source but not
 * across them. Every source starts before `first` runs, so one that subscribes
 * when it starts (as `Events.stream` does) misses nothing published after
 * `first`: a client that has it acts knowing it hears the rest, and `first` may
 * carry a snapshot to resync from. Each client holds the latest `buffer`
 * elements: one that falls behind loses the oldest, never the publisher's time
 * or another client's elements, and repairs from what the subsystem keeps. A
 * source holds its own too (`Events.stream`'s `buffer`): give it as many, since
 * a burst can fill it before its elements move on.
 */
export const eventFeed = <A, E, R>(first: Effect.Effect<A, E, R>, sources: readonly Stream.Stream<A>[], buffer = 1024): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const feed = yield* Effect.acquireRelease(Queue.sliding<A>(buffer), Queue.shutdown);
      // Started at once: each source has subscribed by the time `forkScoped` returns.
      yield* Effect.forEach(
        sources,
        (source) =>
          Effect.forkScoped(
            Stream.runForEach(source, (element) => Queue.offer(feed, element)),
            { startImmediately: true },
          ),
        { discard: true },
      );
      return Stream.concat(Stream.fromEffect(first), Stream.fromQueue(feed));
    }),
  );

const codecs = new WeakMap<Schema.Top, Schema.Codec<unknown, unknown>>();

/**
 * A channel schema's form on the wire, its JSON codec (`Schema.toCodecJson`),
 * made once per schema: the transport decodes payloads and encodes results
 * with it, and a typed client does the reverse, so both agree on what crosses.
 */
export const wireCodec = (schema: Schema.Top): Schema.Codec<unknown, unknown> => {
  let codec = codecs.get(schema);
  if (codec === undefined) codecs.set(schema, (codec = Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>));
  return codec;
};

/** A call's result, however its handler gives it (see `ChannelCall.handle`). */
export const resultOf = (channel: ChannelCall, payload: unknown): Effect.Effect<unknown, unknown> => awaitable(() => channel.handle(payload));

/**
 * A stream's elements, however its handler gives them (see
 * `ChannelStream.handle`). What an async iterable throws is a defect unless it
 * was marked with `fail`, as for a promise.
 */
export const elementsOf = (channel: ChannelStream, payload: unknown): Stream.Stream<unknown, unknown> =>
  Stream.suspend(() => {
    const elements = channel.handle(payload);
    if (Stream.isStream(elements)) return elements;
    return Stream.fromAsyncIterable(elements, (error) => error).pipe(
      Stream.catch((error) => (isExpectedFailure(error) ? Stream.fail(error) : Stream.die(error))),
    );
  });

/**
 * Why a value is not a well-formed channel, or `undefined` when it is: what
 * `Channels` checks of every item added, since a plugin file may have no
 * types. A malformed item fails the plugin's `add` with this reason.
 */
export const channelProblem = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return "a channel is an object";
  const channel = value as Record<string, unknown>;
  if (typeof channel.id !== "string" || channel.id === "") return "its `id` must be a non-empty string";
  const named = (problem: string) => `"${channel.id}": ${problem}`;
  if (channel.kind !== "call" && channel.kind !== "stream")
    return named(`its \`kind\` must be "call" or "stream", not ${JSON.stringify(channel.kind) ?? "undefined"}`);
  if (channel.title !== undefined && typeof channel.title !== "string") return named("its `title` must be a string");
  if (channel.description !== undefined && typeof channel.description !== "string") return named("its `description` must be a string");
  if (!Schema.isSchema(channel.payload)) return named("its `payload` must be a Schema");
  if (!Schema.isSchema(channel.success)) return named("its `success` must be a Schema");
  if (typeof channel.handle !== "function") return named("its `handle` must be a function");
  return undefined;
};

/**
 * The channels host plugins serve, read at each call: the transport does not
 * require them. The first by order answers for an id, so a plugin replaces
 * another's channel by adding one with its id and a lower order: streams open
 * on the one replaced end `Withdrawn`, so their clients reopen on the new one,
 * while calls in flight there finish, since they were made to it.
 */
export const Channels = Registry.make<Channel>("lemma/channels", { key: (channel) => channel.id, check: channelProblem });

/** A channel as clients list it: `source` is the plugin that added it. */
export const ChannelInfo = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["call", "stream"]),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.String,
});
export type ChannelInfo = typeof ChannelInfo.Type;

/**
 * How clients reach `Channels`, by id with the payload and results as JSON;
 * `@lemma/client` encodes and decodes them with a declaration's schemas. The
 * transport serves these beside `HostRpcs`. While the host starts, a request
 * waits until its plugins are up, so a client that has just found the host
 * reaches the channels they serve; one still waiting at the transport's
 * startup timeout fails `Unavailable` (a `HostError`, whose `subject` is the
 * channel when the request names one).
 */
export class ChannelRpcs extends RpcGroup.make(
  /** What host plugins serve: the channel that answers for each id. Fails `Unavailable` while the host starts, as above. */
  Rpc.make("Channel.List", { success: Schema.Array(ChannelInfo), error: HostError }),
  /**
   * Calls a channel. `payload` is its payload schema's JSON form (absent is
   * `null`, what `Schema.Void` takes), and the result is its success schema's
   * JSON form. The call that answers for the id when the request arrives
   * serves it; one in flight when its plugin stops or is replaced finishes on
   * that instance before the instance's finalizers run. Fails with a
   * `HostError` whose `subject` is the channel, unless the handler's domain
   * error names its own (a session, a path): `NotFound` (no call answers for
   * the id, as when its plugin has gone), `InvalidPayload`, the handler's
   * domain error's code (its `reason` or tag), `Failed` (any other failure, a
   * defect, or a result its success schema cannot send), `Withdrawn` (still
   * running at its plugin's dispose deadline, and interrupted), or
   * `Unavailable` (the host still starting at the transport's startup
   * timeout, as above; a handler's domain error may be `Unavailable` too).
   */
  Rpc.make("Channel.Call", { payload: { id: Schema.String, payload: Schema.optional(Schema.Unknown) }, success: Schema.Unknown, error: HostError }),
  /**
   * Opens a channel stream: its elements, encoded as for `Channel.Call`, until
   * it ends. Fails as `Channel.Call` does, except that it ends `Withdrawn` as
   * soon as its plugin stops or is replaced, or another plugin's channel takes
   * over its id, whether or not the client is reading, and is stopped before
   * that plugin's finalizers run: open it again to reach whatever answers for
   * the id now. It ends with the connection and nothing resumes it, so a
   * client reopens it when it reconnects and receives what the channel sends
   * from then on.
   */
  Rpc.make("Channel.Open", {
    payload: { id: Schema.String, payload: Schema.optional(Schema.Unknown) },
    success: Schema.Unknown,
    error: HostError,
    stream: true,
  }),
) {}
