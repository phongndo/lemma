import { Context } from "effect";
import type { Effect, Stream } from "effect";

const EventTypeId: unique symbol = Symbol("@lemma/core/Event");

/**
 * A fire-and-forget notification. Publishing never fails and never waits for
 * observers (except those that chose `overflow: "suspend"`). Use an event only
 * for information that is safe to lose; applications own authoritative state
 * and recovery. Anything whose failure the caller must learn about is a hook
 * (interceptor) or a direct capability call instead.
 */
export interface Event<Payload> {
  readonly name: string;
  readonly [EventTypeId]: (_: Payload) => Payload;
}

export const Event = {
  make<Payload>(name: string): Event<Payload> {
    return Object.freeze({ name }) as Event<Payload>;
  },
};

export interface ObserveOptions {
  /** Payloads held for a slow observer before `overflow` applies. Default 64. */
  readonly buffer?: number;
  /**
   * Default "dropOldest": a slow observer sees a stale view, never a stalled publisher.
   * "suspend" applies backpressure to the publisher; reserve it for observers whose
   * consumer already resyncs from durable state.
   */
  readonly overflow?: "dropOldest" | "dropNewest" | "suspend";
}

/** An observer failure becomes a `PluginFault` (phase "observe") for its owner and affects nothing else. */
export type Observer<Payload, Requirements = never> = (payload: Payload) => Effect.Effect<void, unknown, Requirements>;

export class Events extends Context.Service<
  Events,
  {
    readonly publish: <P>(event: Event<P>, payload: P) => Effect.Effect<void>;
    /** Subscribe from outside a plugin (transports, tests). Ends when the stream's consumer stops or the core closes. */
    readonly stream: <P>(event: Event<P>, options?: ObserveOptions) => Stream.Stream<P>;
  }
>()("@lemma/core/Events") {}
