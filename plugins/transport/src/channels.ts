import { Cause, Context, Effect, Exit, Option, Schema, Stream } from "effect";
import { RpcGroup, RpcMiddleware } from "effect/rpc";
import type { Rpc } from "effect/rpc";
import { Admitted } from "@lemma/core";
import type { Contribution, Registries } from "@lemma/core";
import { answering, Channels, elementsOf, HostError, resultOf, RuntimeRpcs, wireCodec, withChannel, withdrawnFrom } from "@lemma/contracts";
import type { Channel, ChannelInfo, ChannelStream } from "@lemma/contracts";
import { isTagged, toHostError } from "./errors.ts";
import { Startup } from "./startup.ts";

type Reader = Context.Service.Shape<typeof Registries>;

/** The contributions that answer: the first per id. */
export const answers = (items: readonly Contribution<Channel>[]): Contribution<Channel>[] => {
  const seen = new Set<string>();
  return items.filter(({ item }) => !seen.has(item.id) && Boolean(seen.add(item.id)));
};

export const channelInfo = ({ item, pluginId }: Contribution<Channel>): ChannelInfo => ({
  id: item.id,
  kind: item.kind,
  ...(item.title === undefined ? {} : { title: item.title }),
  ...(item.description === undefined ? {} : { description: item.description }),
  source: pluginId,
});

export const listChannels = (registries: Reader): Effect.Effect<ChannelInfo[]> =>
  Effect.map(registries.items(Channels), (items) => answers(items).map(channelInfo));

const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Runs one step of a request on its own: what its schema or handler throws
 * becomes this request's `HostError`, never the connection's, while
 * interruption stays interruption.
 */
const contained = <A, E>(step: () => Effect.Effect<A, E>, error: (cause: Cause.Cause<E>) => HostError): Effect.Effect<A, HostError> =>
  Effect.catchCause(Effect.suspend(step), (cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.fail(error(cause)),
  );

/** An absent payload is JSON's `null`, what `Schema.Void` takes. */
const decode = (channel: Channel, payload: unknown) =>
  contained(
    () => Schema.decodeUnknownEffect(wireCodec(channel.payload))(payload === undefined ? null : payload),
    (cause) => new HostError({ code: "InvalidPayload", subject: channel.id, message: `Invalid payload for "${channel.id}": ${reason(cause)}` }),
  );

const encode = (channel: Channel, value: unknown) =>
  contained(
    () => Schema.encodeUnknownEffect(wireCodec(channel.success))(value),
    (cause) =>
      new HostError({ code: "Failed", subject: channel.id, message: `"${channel.id}" produced a value its success schema cannot send: ${reason(cause)}` }),
  );

/**
 * A domain error keeps its code and subject, as `toHostError` gives them, with
 * the channel as the subject when it names none; any other failure, and any
 * defect, is `Failed`.
 */
const failed = (id: string, cause: Cause.Cause<unknown>): HostError => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && isTagged(failure.value)) {
    const { code, message, subject } = toHostError(failure.value);
    return new HostError({ code, message, subject: subject ?? id });
  }
  return new HostError({ code: "Failed", subject: id, message: reason(cause) });
};

/**
 * One call, served with its channel (`withChannel`), from decoding its payload
 * to encoding its result: when its plugin stops or is replaced, the call is
 * drained, finishing on the instance it started on before that instance's
 * finalizers run, unless its handler stops for the plugin leaving
 * (`CallLifetime`), and is interrupted, `Withdrawn`, only if it outlives the
 * dispose deadline. Its failure or defect is the caller's error, never the
 * transport's.
 */
export const callChannel = (registries: Reader, id: string, payload: unknown): Effect.Effect<unknown, HostError> =>
  withChannel(registries, id, "call", ({ item: channel }, left) =>
    decode(channel, payload).pipe(
      Effect.flatMap((input) =>
        contained(
          () => resultOf(channel, input, { left, withdrawn: withdrawnFrom(id, "call") }),
          (cause) => failed(id, cause),
        ),
      ),
      Effect.flatMap((value) => encode(channel, value)),
    ),
  );

interface Opened {
  readonly channel: ChannelStream;
  readonly input: unknown;
}

/** The channel `ChannelLifetime` found for a `Channel.Open` request, for the request's handler. */
const Opened = Context.Reference<Opened | undefined>("lemma/transport/Opened", { defaultValue: () => undefined });

/**
 * Serves each `Channel.Open` request as work with its channel's contribution
 * (`Registries.run`), so the plugin's finalizers wait for the stream. It wraps
 * the whole request rather than the stream: the RPC server pulls the next
 * chunk only once the client acknowledged the last (WebSocket) or the
 * response drained (streaming HTTP), and only this wrapper can end a request
 * blocked there. When the contribution leaves, or another answers for its id,
 * the request ends `Withdrawn` at once, stopping the stream whether or not the
 * client is reading. So the stream never holds its plugin's disposal, and it
 * runs outside `Admitted`: a change it asks for that restarts its own plugin
 * applies at once, ending it, rather than wait for its client to close it.
 */
export class ChannelLifetime extends RpcMiddleware.Service<ChannelLifetime>()("lemma/transport/ChannelLifetime", { error: HostError }) {}

/** `group`'s RPCs named `tags`, as a group of their own. */
const pick = <R extends Rpc.Any, const Tags extends ReadonlyArray<R["_tag"]>>(group: RpcGroup.RpcGroup<R>, tags: Tags) =>
  RpcGroup.make(...tags.map((tag) => group.requests.get(tag)!)) as unknown as RpcGroup.RpcGroup<Extract<R, { readonly _tag: Tags[number] }>>;

/** The channels' RPCs, each request served with `ChannelLifetime` around it (it passes all but `Channel.Open` through). */
const channelRpcs = ["Channel.List", "Channel.Call", "Channel.Open"] as const;
/** The other RPCs that answer from a registry, which shows what a starting composition contributes only once it is up. */
const registryReaders = ["Host.Inspectors", "Host.Inspect"] as const;

/** What the transport serves: `RuntimeRpcs`, the channels and the registry readers held at the `Startup` gate first. */
export const ServedRpcs = RuntimeRpcs.omit(...channelRpcs, ...registryReaders).merge(
  pick(RuntimeRpcs, registryReaders).merge(pick(RuntimeRpcs, channelRpcs).middleware(ChannelLifetime)).middleware(Startup),
);

export const channelLifetime =
  (registries: Reader): Context.Service.Shape<typeof ChannelLifetime> =>
  (next, { rpc, payload }) =>
    rpc._tag === "Channel.Open" ? openChannel(registries, payload as { readonly id: string; readonly payload?: unknown }, next) : next;

const openChannel = <A, E, R>(registries: Reader, request: { readonly id: string; readonly payload?: unknown }, next: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Admitted, (outside) =>
    withChannel(registries, request.id, "stream", (contribution, left) =>
      Effect.gen(function* () {
        const { id } = request;
        const channel = contribution.item;
        const input = yield* decode(channel, request.payload);
        // Another contribution now answers for the id (a lower order): a client reopening on `Withdrawn` reaches it.
        const overridden = registries.changes(Channels).pipe(
          Stream.filter((items) => answering(items, id) !== contribution),
          Stream.runHead,
        );
        const stream = Effect.provideService(Effect.provideService(next, Opened, { channel, input }), Admitted, outside);
        const ended = yield* Effect.raceFirst(
          Effect.map(Effect.exit(stream), Option.some),
          Effect.as(Effect.raceFirst(left, overridden), Option.none<Exit.Exit<A, E>>()),
        );
        // Stopped, or ended once its channel no longer answered (its plugin stopping its source): withdrawn, not finished.
        if (Option.isNone(ended) || answering(yield* registries.items(Channels), id) !== contribution) return yield* Effect.fail(withdrawnFrom(id, "stream"));
        return yield* ended.value;
      }),
    ),
  );

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
