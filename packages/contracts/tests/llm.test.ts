import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { definePlugin, Events, makeCore, Registries } from "@lemma/core";
import type { Core } from "@lemma/core";
import { channelProblem, Channels, elementsOf, resultOf } from "../src/channels.ts";
import type { Channel, ChannelCall, ChannelStream } from "../src/channels.ts";
import { InteractionOrigin } from "../src/interaction.ts";
import { Llm, LlmError, ModelsChanged, serveLlm } from "../src/llm.ts";
import { callServed } from "../src/testing.ts";
import type { AuthType } from "../src/llm.ts";

/** An `Llm` whose login is `login`, serving its channels as a provider does. */
const provider = (login: (provider: string, type: AuthType) => Effect.Effect<void, LlmError>) =>
  definePlugin({
    id: "llm",
    provides: { llm: Llm },
    setup: function* (_, owner) {
      const llm = Llm.of({
        providers: Effect.succeed([]),
        models: () => Effect.succeed([]),
        model: (ref) => Effect.fail(new LlmError({ reason: "UnknownModel", message: ref })),
        stream: () => Stream.empty,
        login,
        logout: () => Effect.void,
        addCustom: (spec) => Effect.succeed(spec.name),
        removeCustom: () => Effect.void,
        setLogo: () => Effect.void,
      });
      for (const channel of yield* serveLlm(llm, yield* Events)) yield* owner.add(Channels, channel);
      return { llm };
    },
  });

const channelsOf = (core: Core<any>) =>
  Effect.map(
    core.run(Effect.flatMap(Registries, (registries) => registries.items(Channels))),
    (items) => new Map<string, Channel>(items.map(({ item }) => [item.id, item])),
  );

const call = (channels: ReadonlyMap<string, Channel>, id: string, payload: unknown) => resultOf(channels.get(id) as ChannelCall, payload);

/** A login that waits for `release`, counting its starts, recording its origin, and noting an interruption. */
const heldLogin = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const seen = { starts: 0, origins: [] as (string | undefined)[], interrupted: false };
  const login = () =>
    Effect.gen(function* () {
      seen.starts++;
      seen.origins.push(yield* InteractionOrigin);
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => (seen.interrupted = true))));
  return { started, release, seen, login };
});

const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined);

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body).pipe(Effect.timeout(Duration.seconds(5))));

describe("serveLlm", () => {
  test("serves every llm call and its stream of changes, each well formed", () =>
    run(
      Effect.gen(function* () {
        const core = yield* makeCore([provider(() => Effect.void)]);
        const channels = yield* channelsOf(core);
        expect([...channels.values()].map((channel) => [channel.id, channel.kind])).toEqual([
          ["llm.providers", "call"],
          ["llm.models", "call"],
          ["llm.login", "call"],
          ["llm.cancel-login", "call"],
          ["llm.logout", "call"],
          ["llm.add-custom", "call"],
          ["llm.remove-custom", "call"],
          ["llm.set-logo", "call"],
          ["llm.changes", "stream"],
        ]);
        for (const channel of channels.values()) {
          expect(channelProblem(channel)).toBeUndefined();
          expect(channel.title).toBeTruthy();
          expect(channel.description).toBeTruthy();
        }
      }),
    ));

  test("a login outlives its caller; a second call of its type waits for it, and one of the other type is Busy", () =>
    run(
      Effect.gen(function* () {
        const held = yield* heldLogin;
        const core = yield* makeCore([provider(held.login)]);
        const channels = yield* channelsOf(core);
        const first = yield* Effect.forkChild(call(channels, "llm.login", { provider: "p", type: "oauth" }));
        yield* Deferred.await(held.started);
        // The caller goes away: the login goes on, its question still open.
        yield* Fiber.interrupt(first);
        expect(held.seen.interrupted).toBe(false);
        // Started now, so it joins before the login is released.
        const second = yield* Effect.forkChild(call(channels, "llm.login", { provider: "p", type: "oauth" }), { startImmediately: true });
        const other = yield* Effect.exit(call(channels, "llm.login", { provider: "p", type: "api_key" }));
        expect(failure(other)).toMatchObject({ _tag: "LlmError", reason: "Busy", provider: "p", message: 'A oauth login to "p" is in progress' });
        yield* Deferred.succeed(held.release, undefined);
        expect(yield* Fiber.await(second)).toEqual(Exit.succeed(undefined));
        // One flow, under the login's own origin, so its questions and notices show together.
        expect(held.seen).toMatchObject({ starts: 1, origins: ["login:p"] });
        // Ended, a login starts afresh.
        yield* call(channels, "llm.login", { provider: "p", type: "api_key" });
        expect(held.seen.starts).toBe(2);
      }),
    ));

  test("cancelling stops the login for every call waiting on it, and says whether one was running", () =>
    run(
      Effect.gen(function* () {
        const held = yield* heldLogin;
        const core = yield* makeCore([provider(held.login)]);
        const channels = yield* channelsOf(core);
        const waiting = yield* Effect.forkChild(Effect.exit(call(channels, "llm.login", { provider: "p", type: "oauth" })));
        const joined = yield* Effect.forkChild(Effect.exit(call(channels, "llm.login", { provider: "p", type: "oauth" })));
        yield* Deferred.await(held.started);
        expect(yield* call(channels, "llm.cancel-login", { provider: "p" })).toBe(true);
        expect(held.seen.interrupted).toBe(true);
        for (const fiber of [waiting, joined]) {
          expect(failure(yield* Fiber.join(fiber))).toMatchObject({ reason: "Cancelled", provider: "p", message: "The p login was cancelled" });
        }
        expect(yield* call(channels, "llm.cancel-login", { provider: "p" })).toBe(false);
      }),
    ));

  test("a login ends with its provider, while the core runs on", () =>
    run(
      Effect.gen(function* () {
        const held = yield* heldLogin;
        const core = yield* makeCore([provider(held.login)]);
        const channels = yield* channelsOf(core);
        const waiting = yield* Effect.forkChild(Effect.exit(call(channels, "llm.login", { provider: "p", type: "oauth" })));
        yield* Deferred.await(held.started);
        // Replaced, as a change to its config replaces it.
        yield* core.restart("llm", { force: true });
        expect(held.seen.interrupted).toBe(true);
        expect(failure(yield* Fiber.join(waiting))).toMatchObject({ reason: "Cancelled", provider: "p" });
        expect((yield* core.inspect).state).toBe("active");
      }),
    ));

  test("a client's call waiting on a login ends Withdrawn when its provider leaves, despite a long dispose deadline; called again, it logs in anew", () =>
    run(
      Effect.gen(function* () {
        const held = yield* heldLogin;
        const core = yield* makeCore([provider(held.login)], { deadlines: { dispose: Duration.seconds(30) } });
        const registries = yield* core.run(Registries);
        const login = { provider: "p", type: "oauth" };
        // As the transport calls it: within the provider's lifetime, which ends only once the call does.
        const waiting = yield* Effect.forkChild(Effect.exit(callServed(registries, "llm.login", login)));
        yield* Deferred.await(held.started);
        yield* core.restart("llm", { force: true });
        expect(failure(yield* Fiber.join(waiting))).toMatchObject({ _tag: "HostError", code: "Withdrawn", subject: "llm.login" });
        expect(held.seen.interrupted).toBe(true);
        yield* Deferred.succeed(held.release, undefined);
        yield* callServed(registries, "llm.login", login);
        expect(held.seen.starts).toBe(2);
      }),
    ));

  test("changes says it is subscribed first, then sends each change; a reader behind gets one for many", () =>
    run(
      Effect.gen(function* () {
        const core = yield* makeCore([provider(() => Effect.void)]);
        const channels = yield* channelsOf(core);
        const publish = core.run(Effect.flatMap(Events, (events) => events.publish(ModelsChanged, {})));
        const pull = yield* Stream.toPull(elementsOf(channels.get("llm.changes") as ChannelStream, undefined));
        expect(yield* pull).toEqual([{ type: "subscribed" }]);
        // Heard from the moment `subscribed` was sent.
        yield* publish;
        expect(yield* pull).toEqual([{ type: "models-changed" }]);
        yield* Effect.replicateEffect(publish, 3);
        // Every fiber the publishes woke has run: the changes wait, unread.
        yield* Effect.replicateEffect(Effect.yieldNow, 20);
        expect(yield* pull).toEqual([{ type: "models-changed" }]);
        expect(yield* Effect.timeoutOption(pull, Duration.millis(20))).toEqual(Option.none());
      }),
    ));
});
