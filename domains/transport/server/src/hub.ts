import { Deferred, Effect, Queue, Stream } from "effect";
import type { Context } from "effect";
import { changesSince, Channels, Notice, PluginsChanged, toPluginStatus, WebChanged } from "@lemma/contracts";
import type { ClientHello, ClientInfo, InteractionRequest, RuntimeEvent } from "@lemma/contracts";
import type { CoreClosed, Event, EventError, PluginContext, Registries } from "@lemma/core";
import { answers, channelInfo } from "./channels.ts";

/** Per-subscriber buffer for kernel events. A slow client loses the oldest, and resyncs from the calls that list what they report. */
const SUBSCRIBER_BUFFER = 1024;

interface Subscriber {
  /** Whether it answers questions: only such subscribers hold them (`count`, `drained`). */
  readonly answers: boolean;
  /** What it said it is, and since when it is here (`Host.Clients`). */
  readonly client: ClientInfo;
  /** Kernel events: bounded, drop-oldest. */
  readonly feed: Queue.Queue<RuntimeEvent>;
  /** Interaction traffic: never dropped, since a hook is waiting on the answer. */
  readonly inbox: Queue.Queue<RuntimeEvent>;
}

/**
 * Fan-out of the runtime's events to connected clients. Kernel events are
 * observed once, at activation, and copied into every subscriber's queues.
 * Each event kind has its own observer queue, so order holds within a kind
 * but not across kinds.
 */
export interface Hub {
  /**
   * One subscription per run of the stream: `subscribed` once it has joined,
   * then the interactions still open, then what comes. `answers` says whether
   * the subscriber answers questions; one that does not still receives them.
   * `client` is what it says it is.
   */
  readonly events: (answers: boolean, client?: ClientHello) => Stream.Stream<RuntimeEvent | { readonly type: "subscribed" }>;
  /** Every subscriber now, oldest first. */
  readonly clients: Effect.Effect<readonly ClientInfo[]>;
  /** Subscribers that answer questions. */
  readonly count: Effect.Effect<number>;
  /** Lossless delivery to current subscribers, every one of them, for interaction traffic. */
  readonly broadcast: (event: RuntimeEvent) => Effect.Effect<void>;
  /** Resolves when no subscriber that answers questions is attached (immediately if none is). */
  readonly drained: Effect.Effect<void>;
}

export const makeHub = (
  owner: Context.Service.Shape<typeof PluginContext>,
  open: () => Iterable<InteractionRequest>,
  registries: Context.Service.Shape<typeof Registries>,
): Effect.Effect<Hub, EventError | CoreClosed> =>
  Effect.gen(function* () {
    const subscribers = new Set<Subscriber>();
    let drained = yield* Deferred.make<void>();
    yield* Deferred.succeed(drained, undefined);

    const feed = (event: RuntimeEvent) => Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber.feed, event), { discard: true });
    const forward = <P>(event: Event<P>, convert: (payload: P) => RuntimeEvent) =>
      owner.observe(event, (payload) => feed(convert(payload)), { buffer: 256, overflow: "dropOldest" });

    yield* forward(Notice, (notice) => ({ type: "notice", notice }));
    yield* forward(PluginsChanged, (e) => ({ type: "plugins-changed", plugins: e.plugins.map(toPluginStatus) }));
    yield* forward(WebChanged, (web) => ({ type: "web-changed", web }));
    // The channels that answer, each time a different contribution answers for any id. Not the list at start, which
    // clients list themselves: one that changed before this stream began is in its first list, so each is told when it
    // differs from the last told, the start's first.
    const same = <A>(before: readonly A[], after: readonly A[]) =>
      before.length === after.length && before.every((contribution, index) => contribution === after[index]);
    yield* owner.background(
      "channels-changed",
      changesSince(answers(yield* registries.items(Channels)), Stream.map(registries.changes(Channels), answers), same).pipe(
        Stream.runForEach((current) => feed({ type: "channels-changed", channels: current.map(channelInfo) })),
      ),
    );

    const answering = () => {
      let count = 0;
      for (const subscriber of subscribers) if (subscriber.answers) count++;
      return count;
    };
    // Joining and leaving each change the set and `drained` in one synchronous step: no other subscriber comes or goes
    // between them, so the first answerer in replaces a drained `drained`, and the last one out completes the one it
    // replaced, which the grace period may be waiting on.
    const join = (answers: boolean, hello: ClientHello | undefined) =>
      Effect.gen(function* () {
        const client: ClientInfo = {
          kind: hello?.kind ?? "unknown",
          ...(hello?.version === undefined ? {} : { version: hello.version }),
          since: Date.now(),
          answers,
        };
        const subscriber: Subscriber = {
          answers,
          client,
          feed: yield* Queue.sliding<RuntimeEvent>(SUBSCRIBER_BUFFER),
          inbox: yield* Queue.unbounded<RuntimeEvent>(),
        };
        // Nor can an interaction open or close between the replay and joining the set.
        yield* Effect.sync(() => {
          for (const request of open()) Queue.offerUnsafe(subscriber.inbox, { type: "interaction", request });
          subscribers.add(subscriber);
          if (answers && answering() === 1) drained = Deferred.makeUnsafe<void>();
        });
        return subscriber;
      });
    const leave = (subscriber: Subscriber) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          subscribers.delete(subscriber);
          if (subscriber.answers && answering() === 0) Deferred.doneUnsafe(drained, Effect.void);
        });
        yield* Queue.shutdown(subscriber.feed);
        yield* Queue.shutdown(subscriber.inbox);
      });

    // `subscribed` first, once the subscriber has joined: a request's reply on the same socket can overtake the join.
    const events: Hub["events"] = (answers, client) =>
      Stream.unwrap(
        Effect.map(Effect.acquireRelease(join(answers, client), leave), (subscriber) =>
          Stream.concat(Stream.succeed({ type: "subscribed" } as const), Stream.merge(Stream.fromQueue(subscriber.inbox), Stream.fromQueue(subscriber.feed))),
        ),
      );

    return {
      events,
      clients: Effect.sync(() => [...subscribers].map((subscriber) => subscriber.client)),
      count: Effect.sync(answering),
      broadcast: (event) => Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber.inbox, event), { discard: true }),
      drained: Effect.suspend(() => Deferred.await(drained)),
    };
  });
