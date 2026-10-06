import { Cause, Context, Deferred, Effect, Order, Queue, Scope, Stream } from "effect";
import { CoreClosed, EventError, PluginFault } from "../errors.ts";
import type { Event, Events, Observer, ObserveOptions } from "../events.ts";
import type { PluginContext, PluginIdentity } from "../hooks.ts";
import { attributes, withoutParent } from "./hooks.ts";

interface Entry {
  readonly token: object;
  readonly name: string;
  /** Visible subscriptions; publish snapshots this array. */
  subscriptions: readonly Subscription[];
  all: Subscription[];
}

interface Subscription {
  readonly owner: Owner | undefined;
  readonly queue: Queue.Queue<unknown>;
  readonly suspend: boolean;
  /** Completed when unsubscribed, so a suspended publisher never waits on a dead observer. */
  readonly closed: Deferred.Deferred<void>;
  done: boolean;
}

interface Owner {
  readonly identity: PluginIdentity;
  visible: boolean;
  accepting: boolean;
}

export interface EventSnapshot {
  readonly name: string;
  readonly observers: readonly string[];
}

export interface ObserverHandle {
  readonly observe: Context.Tag.Service<PluginContext>["observe"];
  readonly publish: () => void;
  readonly retire: () => void;
}

const DEFAULT_BUFFER = 64;

/**
 * Fan-out with one bounded queue per observer. Publishing offers to each visible
 * queue and never fails; an observer runs on its owner's scope and its failures
 * are reported as faults, never propagated.
 */
export class EventBus implements Context.Tag.Service<Events> {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.closed = true;
      const subscriptions = [...this.entries.values()].flatMap((entry) => entry.all);
      this.entries.clear();
      return Effect.forEach(
        subscriptions,
        (subscription) =>
          Effect.gen(function* () {
            subscription.done = true;
            yield* Deferred.succeed(subscription.closed, undefined);
            yield* Queue.shutdown(subscription.queue);
          }),
        { discard: true },
      );
    });
  }

  inspect(): readonly EventSnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => entry.subscriptions.some((subscription) => subscription.owner))
      .sort((a, b) => Order.string(a.name, b.name))
      .map((entry) => ({
        name: entry.name,
        observers: entry.subscriptions.flatMap((subscription) => (subscription.owner ? [subscription.owner.identity.id] : [])),
      }));
  }

  owner(identity: PluginIdentity, scope: Scope.Scope, visible: boolean, report: (fault: PluginFault) => Effect.Effect<void>): ObserverHandle {
    const owner: Owner = { identity, visible, accepting: true };
    const owned = new Set<Entry>();
    const observe = <P, R>(event: Event<P>, observer: Observer<P, R>, options: ObserveOptions = {}) =>
      Effect.uninterruptible(
        Effect.gen(this, function* () {
          if (this.closed || !owner.accepting) return yield* new CoreClosed();
          const entry = yield* this.entry(event);
          const environment = withoutParent(yield* Effect.context<R>());
          const subscription = yield* this.subscribe(entry, owner, options, scope);
          owned.add(entry);
          const consume = Queue.take(subscription.queue).pipe(
            Effect.flatMap((payload) =>
              Effect.suspend(() => observer(payload as P)).pipe(
                Effect.provide(environment),
                Effect.withSpan("core.observe", {
                  captureStackTrace: false,
                  attributes: { ...attributes(identity), "event.name": event.name },
                }),
                Effect.catchAllCause((cause) =>
                  Cause.isInterruptedOnly(cause)
                    ? Effect.failCause(cause)
                    : report(new PluginFault({ pluginId: identity.id, phase: "observe", operation: event.name, cause })),
                ),
              ),
            ),
            Effect.forever,
          );
          // Forked fibers inherit interruptibility; the consumer must stop when the scope closes.
          yield* Effect.forkIn(Effect.interruptible(consume), scope);
        }).pipe(Effect.asVoid),
      );
    const each = () => {
      for (const entry of owned) rebuild(entry);
    };
    return {
      observe,
      publish: () => {
        owner.visible = true;
        each();
      },
      retire: () => {
        owner.accepting = false;
        owner.visible = false;
        each();
      },
    };
  }

  readonly publish = <P>(event: Event<P>, payload: P): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (this.closed) return Effect.void;
      const entry = this.entries.get(event.name);
      if (!entry || entry.token !== event || entry.subscriptions.length === 0) return Effect.void;
      const subscriptions = entry.subscriptions;
      // Sliding and dropping offers never wait; only "suspend" subscriptions need their own fiber.
      return Effect.forEach(
        subscriptions,
        (subscription) =>
          Effect.suspend(() => {
            if (subscription.done) return Effect.void;
            const offer = Queue.offer(subscription.queue, payload);
            return (subscription.suspend ? Effect.race(offer, Deferred.await(subscription.closed)) : offer).pipe(
              Effect.catchAllCause((cause) => (subscription.done ? Effect.void : Effect.failCause(cause))),
            );
          }),
        { concurrency: subscriptions.some((subscription) => subscription.suspend) ? "unbounded" : 1, discard: true },
      );
    });

  readonly stream = <P>(event: Event<P>, options: ObserveOptions = {}): Stream.Stream<P> =>
    Stream.unwrapScoped(
      Effect.gen(this, function* () {
        if (this.closed) return Stream.empty;
        const entry = yield* this.entry(event).pipe(Effect.orDie);
        const scope = yield* Effect.scope;
        const subscription = yield* this.subscribe(entry, undefined, options, scope);
        return Stream.fromQueue(subscription.queue) as Stream.Stream<P>;
      }),
    );

  private subscribe(entry: Entry, owner: Owner | undefined, options: ObserveOptions, scope: Scope.Scope) {
    return Effect.gen(this, function* () {
      const buffer = options.buffer ?? DEFAULT_BUFFER;
      if (!Number.isInteger(buffer) || buffer < 1) {
        return yield* Effect.die(new EventError({ reason: "InvalidBuffer", event: entry.name, message: "Observer buffer must be a positive integer" }));
      }
      const overflow = options.overflow ?? "dropOldest";
      const queue = yield* overflow === "dropOldest"
        ? Queue.sliding<unknown>(buffer)
        : overflow === "dropNewest"
          ? Queue.dropping<unknown>(buffer)
          : Queue.bounded<unknown>(buffer);
      const subscription: Subscription = { owner, queue, suspend: overflow === "suspend", closed: yield* Deferred.make<void>(), done: false };
      entry.all.push(subscription);
      rebuild(entry);
      yield* Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          subscription.done = true;
          entry.all = entry.all.filter((candidate) => candidate !== subscription);
          rebuild(entry);
          yield* Deferred.succeed(subscription.closed, undefined);
          yield* Queue.shutdown(queue);
        }),
      );
      return subscription;
    });
  }

  private entry(event: { readonly name: string }): Effect.Effect<Entry, EventError> {
    return Effect.suspend(() => {
      const existing = this.entries.get(event.name);
      if (existing) {
        if (existing.token !== event) {
          return Effect.fail(
            new EventError({
              reason: "PointConflict",
              event: event.name,
              message: `Different event tokens use the name "${event.name}"; import the shared token instead`,
            }),
          );
        }
        return Effect.succeed(existing);
      }
      const entry: Entry = { token: event, name: event.name, subscriptions: [], all: [] };
      this.entries.set(event.name, entry);
      return Effect.succeed(entry);
    });
  }
}

function rebuild(entry: Entry): void {
  entry.subscriptions = entry.all.filter((subscription) => !subscription.owner || subscription.owner.visible);
}
