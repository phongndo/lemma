import { Effect, Schema, Stream } from "effect";
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
 * anything else is `Failed`.
 */
export interface ChannelCall<Payload = any, Success = any> extends ChannelDeclaration<"call", Payload, Success> {
  readonly handle: (payload: Payload) => Awaitable<Success, unknown>;
}

/**
 * Sends elements until it ends, fails as a call does, or the client stops it:
 * a Stream, or an async iterable (an `async function*`) from promise code.
 * Elements go out as the client takes them, so a slow client holds the stream
 * back: one that must not wait (live prices) drops what the client has not
 * taken, as `Stream.buffer({ capacity: 1, strategy: "sliding" })` does.
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
 * The channels host plugins serve, read at each call: the transport does not
 * require them. The first by order answers for an id, so a plugin replaces
 * another's channel by adding one with its id and a lower order.
 */
export const Channels = Registry.make<Channel>("lemma/channels", { key: (channel) => channel.id });

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
 * transport serves these beside `HostRpcs`.
 */
export class ChannelRpcs extends RpcGroup.make(
  /** What host plugins serve: the channel that answers for each id. */
  Rpc.make("Channel.List", { success: Schema.Array(ChannelInfo) }),
  /**
   * Calls a channel. `payload` is its payload schema's JSON form (absent is
   * `null`, what `Schema.Void` takes), and the result is its success schema's
   * JSON form. A call
   * in flight when its plugin stops or is replaced finishes on that instance
   * before the instance's finalizers run. Fails, with the channel as
   * `subject`: `NotFound` (no call by that id, including one whose plugin has
   * gone), `InvalidPayload`, the handler's domain error's code (its `reason`
   * or tag), `Failed` (any other failure, a defect, or a result its success
   * schema cannot send), or `Withdrawn` (still running at its plugin's dispose
   * deadline, and interrupted).
   */
  Rpc.make("Channel.Call", { payload: { id: Schema.String, payload: Schema.optional(Schema.Unknown) }, success: Schema.Unknown, error: HostError }),
  /**
   * Opens a channel stream: its elements, encoded as for `Channel.Call`, until
   * it ends. Fails as `Channel.Call` does, except that it ends `Withdrawn` as
   * soon as its plugin stops or is replaced, whether or not the client is
   * reading, and is stopped before that plugin's finalizers run: open it again
   * to reach the replacement. It ends with the connection and nothing resumes
   * it, so a client reopens it when it reconnects and receives what the
   * channel sends from then on.
   */
  Rpc.make("Channel.Open", {
    payload: { id: Schema.String, payload: Schema.optional(Schema.Unknown) },
    success: Schema.Unknown,
    error: HostError,
    stream: true,
  }),
) {}
