import { Cause, Effect, Fiber, Queue, Schema, SchemaTransformation, Stream } from "effect";
import type { Context } from "effect";
import { awaitable, isExpectedFailure, Registry } from "@lemma/core";
import type { Awaitable, Contribution, Registries, RegistryError } from "@lemma/core";
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
  /**
   * `<subsystem>.<name>`, a multiword name in kebab-case. The subsystem is the
   * capability the channel serves, whichever plugin provides it, bundled or a
   * replacement (`sessions.set-title`, `files.search`), or else the plugin
   * (`ticker.prices`). Unique by convention: of channels with one id, the
   * first by order answers (see `Channels`).
   */
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  /**
   * Decodes what a client sends; a payload it rejects fails `InvalidPayload`
   * before the handler runs. `Schema.Void` takes none; `optionalPayload` lets
   * a client leave out one whose fields are all optional.
   */
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
 *
 * A call that waits on what only its plugin's stopping would end (a turn, a
 * login, a running command) would hold that stop until the deadline: it
 * stops waiting when its plugin leaves instead, as its second argument
 * (`CallLifetime`) tells it, and its client gets `Withdrawn` at once and
 * calls again, reaching the replacement.
 */
export interface ChannelCall<Payload = any, Success = any> extends ChannelDeclaration<"call", Payload, Success> {
  readonly handle: (payload: Payload, lifetime: CallLifetime) => Awaitable<Success, unknown>;
}

/**
 * What a call's handler hears of its plugin leaving: stopping, failing, or
 * being replaced, or the host closing. A handler that stops for it ends with
 * the call's `Withdrawn`, which both carry. One that takes no notice finishes
 * as before.
 */
export interface CallLifetime {
  /** Fails with the call's `Withdrawn` once the plugin has left: race what waits with it, `Effect.raceFirst(wait, left)`. */
  readonly left: Effect.Effect<never, HostError>;
  /**
   * For promise code, aborted once the call no longer matters. When the
   * plugin leaves, its reason is that `Withdrawn`, and a handler that rejects
   * with it (`signal.throwIfAborted()`, `fetch`), or with an error it caused
   * (Node's `AbortError`), ends `Withdrawn` too. When the call is interrupted
   * instead (its client dropped or cancelled it), it aborts with the default
   * `AbortError`, as `awaitable`'s signal does, so what the handler started
   * stops with the call.
   */
  readonly signal: AbortSignal;
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
 * channel through `RuntimeRpcs`' `Channel.*`, so a plugin offers its own data
 * without a change to these contracts or the transport. A plugin adds one to
 * `Channels` with `PluginContext.add`; it belongs to that plugin and leaves
 * with it, which ends its open streams. Nothing has to provide anything for it
 * to be added.
 */
export type Channel = ChannelCall | ChannelStream;

/** A declaration typed by its schemas: `const prices = defineChannel({ kind: "stream", id: "ticker.prices", … })`. */
export const defineChannel = <const Kind extends ChannelKind, Payload, Success>(
  declaration: ChannelDeclaration<Kind, Payload, Success>,
): ChannelDeclaration<Kind, Payload, Success> => declaration;

/**
 * A payload of `fields` that a client may leave out: none (`null` on the wire)
 * decodes as `{}`. For a call whose fields are all optional, such as a
 * listing's filters, so a client calling it by id needs no `{}`
 * (`lemma channels call sessions.list`). A typed client still passes an object.
 */
export const optionalPayload = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const struct = Schema.Struct(fields);
  return Schema.NullOr(struct).pipe(
    Schema.decodeTo(
      Schema.toType(struct),
      SchemaTransformation.transform({
        decode: (payload) => payload ?? ({} as typeof struct.Type),
        encode: (payload) => payload,
      }),
    ),
  );
};

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

/** Whether `cause` is a handler stopping for `reason`: failing or dying with it, or with an error it caused. */
const stoppedFor = (cause: Cause.Cause<unknown>, reason: unknown): boolean => {
  const error = Cause.squash(cause);
  return error === reason || (typeof error === "object" && error !== null && (error as { readonly cause?: unknown }).cause === reason);
};

/**
 * A call's result, however its handler gives it (see `ChannelCall.handle`).
 * `served` is the lifetime of the plugin serving it: `left` completes when
 * that plugin leaves (`Registries.run`'s), and a handler that stops for it
 * fails with `withdrawn`. Without it, as outside a host, the plugin never
 * leaves. Either way the handler's `signal` aborts if the call is interrupted.
 */
export const resultOf = (
  channel: ChannelCall,
  payload: unknown,
  served?: { readonly left: Effect.Effect<void>; readonly withdrawn: HostError },
): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    // The signal, and the fiber that aborts it when the plugin leaves, are made only for a handler that reads it.
    let controller: AbortController | undefined;
    let aborter: Fiber.Fiber<void> | undefined;
    let interrupted = false;
    const lifetime: CallLifetime = {
      left: served === undefined ? Effect.never : Effect.andThen(served.left, Effect.fail(served.withdrawn)),
      get signal() {
        if (controller === undefined) {
          const made = (controller = new AbortController());
          // Read by promise code still running after the call was interrupted: aborted already.
          if (interrupted) made.abort();
          else if (served !== undefined)
            aborter = Effect.runFork(
              Effect.andThen(
                served.left,
                Effect.sync(() => made.abort(served.withdrawn)),
              ),
            );
        }
        return controller.signal;
      },
    };
    const result = awaitable(() => channel.handle(payload, lifetime)).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true;
          controller?.abort();
        }),
      ),
      Effect.ensuring(Effect.suspend(() => (aborter === undefined ? Effect.void : Fiber.interrupt(aborter)))),
    );
    if (served === undefined) return result;
    const { withdrawn } = served;
    return Effect.catchCause(result, (cause) => (stoppedFor(cause, withdrawn) ? Effect.fail(withdrawn) : Effect.failCause(cause)));
  });

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

/** The contribution that answers for `id`: the first by order. */
export const answering = (items: readonly Contribution<Channel>[], id: string): Contribution<Channel> | undefined =>
  items.find((contribution) => contribution.item.id === id);

const notFound = (id: string) => new HostError({ code: "NotFound", subject: id, message: `No channel "${id}"` });

/** What a request to `id` ends with when the plugin serving it left first: a client calls or opens it again. */
export const withdrawnFrom = (id: string, kind: ChannelKind): HostError =>
  new HostError({
    code: "Withdrawn",
    subject: id,
    message: `"${id}" was withdrawn: its plugin stopped or was replaced; ${kind === "call" ? "call" : "open"} it again to reach its replacement`,
  });

/**
 * Runs `work` with the contribution `find` finds, as part of its
 * contributor's lifetime (`Registries.run`) from the moment it is found, as a
 * plugin serves a request with what another plugin contributed (a channel, a
 * command): all of `work` ends before that contributor's finalizers run, and
 * `left` completes when the contribution leaves. If it left before the work
 * was admitted, as when a reload replaced it, it calls `find` again, since a
 * replacement may answer now. It fails `missing` when `find` finds nothing, or
 * only what had left, and `expired` when the work outlives its contributor's
 * dispose deadline.
 */
export const withContribution = <I, A, E, R, F, RF, M, X>(
  registries: Context.Service.Shape<typeof Registries>,
  find: () => Effect.Effect<Contribution<I> | undefined, F, RF>,
  work: (contribution: Contribution<I>, left: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  errors: { readonly missing: () => M; readonly expired: (contribution: Contribution<I>, error: RegistryError) => X },
): Effect.Effect<A, E | F | M | X, R | RF> => {
  // `refused`: the contribution that had left when it was found, which a second look must not find again.
  const attempt = (refused?: Contribution<I>): Effect.Effect<A, E | F | M | X, R | RF> =>
    Effect.flatMap(find(), (found) =>
      found === undefined || found === refused
        ? Effect.fail(errors.missing())
        : registries
            .run(found, (left) => Effect.exit(work(found, left)))
            .pipe(
              Effect.matchEffect({
                onFailure: (error) => (error.reason === "Absent" ? attempt(found) : Effect.fail(errors.expired(found, error))),
                onSuccess: (exit) => exit,
              }),
            ),
    );
  return attempt();
};

const find = <Kind extends ChannelKind>(registries: Context.Service.Shape<typeof Registries>, id: string, kind: Kind) =>
  Effect.flatMap(registries.items(Channels), (items): Effect.Effect<Contribution<Extract<Channel, { readonly kind: Kind }>> | undefined, HostError> => {
    const found = answering(items, id);
    if (found !== undefined && found.item.kind !== kind) {
      const verb = found.item.kind === "call" ? "call" : "open";
      return Effect.fail(new HostError({ code: "NotFound", subject: id, message: `"${id}" is a ${found.item.kind}, not a ${kind}: ${verb} it` }));
    }
    return Effect.succeed(found as Contribution<Extract<Channel, { readonly kind: Kind }>> | undefined);
  });

/**
 * Runs `work` with the channel that answers for `id`, as a transport serves a
 * client's request: within its plugin's lifetime, with the one answering now
 * if a reload replaced it first (`withContribution`). It fails `NotFound`
 * only when nothing answers, or a channel of the other kind does, and
 * `Withdrawn` (`withdrawnFrom`) when it outlives its plugin's dispose
 * deadline.
 */
export const withChannel = <Kind extends ChannelKind, A, E, R>(
  registries: Context.Service.Shape<typeof Registries>,
  id: string,
  kind: Kind,
  work: (contribution: Contribution<Extract<Channel, { readonly kind: Kind }>>, left: Effect.Effect<void>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HostError, R> =>
  withContribution(registries, () => find(registries, id, kind), work, { missing: () => notFound(id), expired: () => withdrawnFrom(id, kind) });

/** A channel as clients list it: `source` is the plugin that added it. */
export const ChannelInfo = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["call", "stream"]),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.String,
});
export type ChannelInfo = typeof ChannelInfo.Type;
