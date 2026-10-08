import { Cause, Context, Effect, Exit, Option, Schema, Stream } from "effect";
import { RpcMiddleware } from "effect/rpc";
import type { Contribution, Registries, RegistryError } from "@lemma/core";
import { ChannelRpcs, Channels, elementsOf, HostError, HostRpcs, resultOf } from "@lemma/contracts";
import type { Channel, ChannelInfo, ChannelStream } from "@lemma/contracts";
import { isTagged, toHostError } from "./errors.ts";

type Reader = Context.Service.Shape<typeof Registries>;

/** The first channel per id: the one that answers for it. */
export const listChannels = (registries: Reader): Effect.Effect<ChannelInfo[]> =>
  Effect.map(registries.items(Channels), (items) => {
    const seen = new Set<string>();
    return items.flatMap(({ item, pluginId }) => {
      if (seen.has(item.id)) return [];
      seen.add(item.id);
      return [
        {
          id: item.id,
          kind: item.kind,
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.description === undefined ? {} : { description: item.description }),
          source: pluginId,
        },
      ];
    });
  });

const notFound = (id: string) => new HostError({ code: "NotFound", subject: id, message: `No channel "${id}"` });

const find = <Kind extends Channel["kind"]>(registries: Reader, id: string, kind: Kind) =>
  Effect.flatMap(registries.items(Channels), (items): Effect.Effect<Contribution<Extract<Channel, { readonly kind: Kind }>>, HostError> => {
    const found = items.find((contribution) => contribution.item.id === id);
    if (found === undefined) return Effect.fail(notFound(id));
    if (found.item.kind !== kind) {
      const verb = found.item.kind === "call" ? "call" : "open";
      return Effect.fail(new HostError({ code: "NotFound", subject: id, message: `"${id}" is a ${found.item.kind}, not a ${kind}: ${verb} it` }));
    }
    return Effect.succeed(found as Contribution<Extract<Channel, { readonly kind: Kind }>>);
  });

/** A channel's payloads and results cross as JSON, through each schema's JSON codec (see `ChannelDeclaration`). */
const codecs = new WeakMap<Schema.Top, Schema.Codec<unknown, unknown>>();
const json = (schema: Schema.Top) => {
  let codec = codecs.get(schema);
  if (codec === undefined) codecs.set(schema, (codec = Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>));
  return codec;
};

/** An absent payload is JSON's `null`, what `Schema.Void` takes. */
const decode = (channel: Channel, payload: unknown) =>
  Schema.decodeUnknownEffect(json(channel.payload))(payload === undefined ? null : payload).pipe(
    Effect.mapError(
      (error) => new HostError({ code: "InvalidPayload", subject: channel.id, message: `Invalid payload for "${channel.id}": ${error.message}` }),
    ),
  );

const encode = (channel: Channel, value: unknown) =>
  Schema.encodeUnknownEffect(json(channel.success))(value).pipe(
    Effect.mapError(
      (error) =>
        new HostError({ code: "Failed", subject: channel.id, message: `"${channel.id}" produced a value its success schema cannot send: ${error.message}` }),
    ),
  );

/** A domain error keeps its code, as `toHostError` gives it; any other failure, and any defect, is `Failed`. */
const failed = (id: string, cause: Cause.Cause<unknown>): HostError => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && isTagged(failure.value)) {
    const { code, message } = toHostError(failure.value);
    return new HostError({ code, message, subject: id });
  }
  const error = Cause.squash(cause);
  return new HostError({ code: "Failed", subject: id, message: error instanceof Error ? error.message : String(error) });
};

const withdrawn = (id: string) =>
  new HostError({
    code: "Withdrawn",
    subject: id,
    message: `"${id}" was withdrawn: its plugin stopped or was replaced; open it again to reach its replacement`,
  });

/** What `Registries.run` refusing or cutting off a request means to its client. */
const lost = (id: string) => (error: RegistryError) => (error.reason === "Absent" ? notFound(id) : withdrawn(id));

/**
 * One call, run as work with its channel's contribution (`Registries.run`):
 * when its plugin stops or is replaced, the call is drained, finishing on the
 * instance it started on before that instance's finalizers run, and is
 * interrupted, `Withdrawn`, only if it outlives the dispose deadline. Its
 * failure or defect is the caller's error, never the transport's.
 */
export const callChannel = (registries: Reader, id: string, payload: unknown): Effect.Effect<unknown, HostError> =>
  Effect.gen(function* () {
    const contribution = yield* find(registries, id, "call");
    const channel = contribution.item;
    const input = yield* decode(channel, payload);
    const exit = yield* registries.run(contribution, () => Effect.exit(resultOf(channel, input))).pipe(Effect.mapError(lost(id)));
    if (Exit.isFailure(exit)) return yield* Effect.fail(failed(id, exit.cause));
    return yield* encode(channel, exit.value);
  });

interface Opened {
  readonly channel: ChannelStream;
  readonly input: unknown;
}

/** The channel `ChannelLifetime` found for a `Channel.Open` request, for the request's handler. */
const Opened = Context.Reference<Opened | undefined>("lemma/transport/Opened", { defaultValue: () => undefined });

/**
 * Serves each `Channel.Open` request as work with its channel's contribution
 * (`Registries.run`), so the plugin's finalizers wait for the stream. It wraps
 * the whole request rather than the stream: the RPC server waits for the
 * client to acknowledge each chunk before it pulls the next, and only this
 * wrapper can end a request blocked there. When the contribution leaves, the
 * request ends `Withdrawn` at once, stopping the stream whether or not the
 * client is reading.
 */
export class ChannelLifetime extends RpcMiddleware.Service<ChannelLifetime>()("lemma/transport/ChannelLifetime", { error: HostError }) {}

/** What the transport serves: `HostRpcs`, and `ChannelRpcs` with `ChannelLifetime` around each request (it passes all but `Channel.Open` through). */
export const ServedRpcs = HostRpcs.merge(ChannelRpcs.middleware(ChannelLifetime));

export const channelLifetime =
  (registries: Reader): Context.Service.Shape<typeof ChannelLifetime> =>
  (next, { rpc, payload }) =>
    rpc._tag === "Channel.Open" ? openChannel(registries, payload as { readonly id: string; readonly payload?: unknown }, next) : next;

const openChannel = <A, E, R>(registries: Reader, request: { readonly id: string; readonly payload?: unknown }, next: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { id } = request;
    const contribution = yield* find(registries, id, "stream");
    const channel = contribution.item;
    const input = yield* decode(channel, request.payload);
    const ended = yield* registries
      .run(contribution, (left) =>
        Effect.raceFirst(
          Effect.map(Effect.exit(Effect.provideService(next, Opened, { channel, input })), Option.some),
          Effect.as(left, Option.none<Exit.Exit<A, E>>()),
        ),
      )
      .pipe(Effect.mapError(lost(id)));
    // Stopped when its channel left, or ended once it had (its plugin stopping its source): withdrawn, not finished.
    if (Option.isNone(ended) || !(yield* registries.items(Channels)).includes(contribution)) return yield* Effect.fail(withdrawn(id));
    return yield* ended.value;
  });

/** The stream `ChannelLifetime` opened for this request, encoded for the wire. */
export const openedStream: Stream.Stream<unknown, HostError> = Stream.unwrap(
  Effect.gen(function* () {
    const opened = yield* Opened;
    if (opened === undefined) return Stream.die(new Error("Channel.Open was served without ChannelLifetime"));
    const { channel, input } = opened;
    return elementsOf(channel, input).pipe(
      Stream.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Stream.failCause(cause as Cause.Cause<never>) : Stream.fail(failed(channel.id, cause)))),
      Stream.mapEffect((element) => encode(channel, element)),
    );
  }),
);
