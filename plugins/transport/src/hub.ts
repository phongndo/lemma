import { Deferred, Effect, Queue, Stream } from "effect";
import type { Context } from "effect";
import {
  AssistantDelta,
  CommandsChanged,
  ModelsChanged,
  Notice,
  PluginsChanged,
  QueueChanged,
  SessionAppended,
  SessionChanged,
  SessionRemoved,
  ToolOutput,
  TurnEnded,
  TurnStarted,
  UiChanged,
} from "@lemma/contracts";
import type { HostEvent, InteractionRequest } from "@lemma/contracts";
import type { CoreClosed, Event, EventError, PluginContext } from "@lemma/core";
import { toPluginStatus } from "./errors.ts";

/** Per-subscriber buffer for kernel events. A slow client loses the oldest and repairs from the session log. */
const SUBSCRIBER_BUFFER = 1024;

interface Subscriber {
  /** Kernel events: bounded, drop-oldest. */
  readonly feed: Queue.Queue<HostEvent>;
  /** Interaction traffic: never dropped, since a hook is waiting on the answer. */
  readonly inbox: Queue.Queue<HostEvent>;
}

/**
 * Fan-out of host events to connected clients. Kernel events are observed
 * once, at activation, and copied into every subscriber's queues. Each event
 * kind has its own observer queue, so order holds within a kind but not across
 * kinds (`turn-ended` can overtake the last `delta`).
 */
export interface Hub {
  /** One subscription per run of the stream; it starts with the interactions still open. */
  readonly events: Stream.Stream<HostEvent>;
  readonly count: Effect.Effect<number>;
  /** Lossless delivery to current subscribers, for interaction traffic. */
  readonly broadcast: (event: HostEvent) => Effect.Effect<void>;
  /** Resolves when no subscriber is attached (immediately if none is). */
  readonly drained: Effect.Effect<void>;
}

export const makeHub = (owner: Context.Tag.Service<PluginContext>, open: () => Iterable<InteractionRequest>): Effect.Effect<Hub, EventError | CoreClosed> =>
  Effect.gen(function* () {
    const subscribers = new Set<Subscriber>();
    let drained = yield* Deferred.make<void>();
    yield* Deferred.succeed(drained, undefined);

    const feed = (event: HostEvent) => Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber.feed, event), { discard: true });
    const forward = <P>(event: Event<P>, convert: (payload: P) => HostEvent, buffer = 256) =>
      owner.observe(event, (payload) => feed(convert(payload)), { buffer, overflow: "dropOldest" });

    yield* forward(
      AssistantDelta,
      (e) => ({ type: "delta", sessionId: e.sessionId, turnId: e.turnId, stepId: e.stepId, seq: e.seq, event: e.event }),
      SUBSCRIBER_BUFFER,
    );
    yield* forward(
      ToolOutput,
      (e) => ({ type: "tool-output", sessionId: e.sessionId, toolCallId: e.toolCallId, chunk: e.chunk, offset: e.offset }),
      SUBSCRIBER_BUFFER,
    );
    yield* forward(TurnStarted, (e) => ({ type: "turn-started", sessionId: e.sessionId, turnId: e.turnId }));
    yield* forward(QueueChanged, (e) => ({ type: "queue-changed", sessionId: e.sessionId, queue: e.queue, revision: e.revision }));
    yield* forward(TurnEnded, (e) => ({ type: "turn-ended", sessionId: e.sessionId, turnId: e.turnId, usage: e.usage, reason: e.reason }));
    yield* forward(SessionAppended, (e) => ({ type: "session-appended", sessionId: e.sessionId, event: e.event }), SUBSCRIBER_BUFFER);
    yield* forward(SessionChanged, (e) => ({ type: "session-changed", info: e.info }));
    yield* forward(SessionRemoved, (e) => ({ type: "session-removed", sessionId: e.sessionId }));
    yield* forward(Notice, (notice) => ({ type: "notice", notice }));
    yield* forward(PluginsChanged, (e) => ({ type: "plugins-changed", plugins: e.plugins.map(toPluginStatus) }));
    yield* forward(CommandsChanged, (e) => ({ type: "commands-changed", commands: e.commands }));
    yield* forward(ModelsChanged, () => ({ type: "models-changed" }));
    yield* forward(UiChanged, (ui) => ({ type: "ui-changed", ui }));

    const join = Effect.gen(function* () {
      const subscriber: Subscriber = { feed: yield* Queue.sliding<HostEvent>(SUBSCRIBER_BUFFER), inbox: yield* Queue.unbounded<HostEvent>() };
      // Synchronous from here: no interaction can open or close between the replay and joining the set.
      yield* Effect.sync(() => {
        for (const request of open()) subscriber.inbox.unsafeOffer({ type: "interaction", request });
        subscribers.add(subscriber);
      });
      if (subscribers.size === 1) drained = yield* Deferred.make<void>();
      return subscriber;
    });
    const leave = (subscriber: Subscriber) =>
      Effect.gen(function* () {
        subscribers.delete(subscriber);
        yield* Queue.shutdown(subscriber.feed);
        yield* Queue.shutdown(subscriber.inbox);
        if (subscribers.size === 0) yield* Deferred.succeed(drained, undefined);
      });

    const events: Stream.Stream<HostEvent> = Stream.unwrapScoped(
      Effect.map(Effect.acquireRelease(join, leave), (subscriber) => Stream.merge(Stream.fromQueue(subscriber.inbox), Stream.fromQueue(subscriber.feed))),
    );

    return {
      events,
      count: Effect.sync(() => subscribers.size),
      broadcast: (event) => Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber.inbox, event), { discard: true }),
      drained: Effect.suspend(() => Deferred.await(drained)),
    };
  });
