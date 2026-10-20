import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { makeSignIns } from "../src/signin.ts";
import type { SignIn } from "../src/llm.ts";

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body).pipe(Effect.timeout(Duration.seconds(5))));

const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined);

/** Waits until the provider's sign-in is listed as `wanted` says. */
const until = (list: Stream.Stream<readonly SignIn[]>, wanted: (signIn: SignIn | undefined) => boolean, provider = "p") =>
  Stream.runHead(Stream.filter(list, (signIns) => wanted(signIns.find((signIn) => signIn.provider === provider)))).pipe(
    Effect.map((found) => Option.getOrThrow(found).find((signIn) => signIn.provider === provider)),
  );

describe("makeSignIns", () => {
  test("lists a sign-in's steps, takes the answer to its open step, and refuses one to a step gone by", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* makeSignIns();
        const answered = yield* Deferred.make<string>();
        const login = yield* Effect.forkChild(
          signIns.run(
            "p",
            "oauth",
            (signIn) =>
              Effect.gen(function* () {
                signIn.show({ type: "browser", url: "https://auth.test/authorize" });
                const pasted = yield* signIn.ask({ type: "browser", url: "https://auth.test/authorize", paste: { placeholder: "http://127.0.0.1:1455/cb" } });
                yield* Deferred.succeed(answered, pasted);
                signIn.show({ type: "working", message: "Exchanging the code" });
                return "you@example.com";
              }),
            (account) => `as ${account}`,
          ),
        );
        const asking = yield* until(signIns.list, (signIn) => signIn?.step.type === "browser" && signIn.step.paste !== undefined);
        expect(asking).toMatchObject({ provider: "p", method: "oauth", step: { type: "browser", url: "https://auth.test/authorize" } });
        // A step gone by, and one never asked, are refused.
        expect(failure(yield* Effect.exit(signIns.answer("p", asking!.seq - 1, "x")))).toMatchObject({ reason: "NotAsked", provider: "p" });
        expect(failure(yield* Effect.exit(signIns.answer("q", asking!.seq, "x")))).toMatchObject({ reason: "NotAsked", provider: "q" });
        yield* signIns.answer("p", asking!.seq, "http://127.0.0.1:1455/cb?code=c");
        expect(yield* Deferred.await(answered)).toBe("http://127.0.0.1:1455/cb?code=c");
        // The first answer wins.
        expect(failure(yield* Effect.exit(signIns.answer("p", asking!.seq, "again")))).toMatchObject({ reason: "NotAsked" });
        yield* Fiber.join(login);
        expect(signIns.current()).toMatchObject([{ provider: "p", ended: { outcome: "signed-in", detail: "as you@example.com" } }]);
      }),
    ));

  test("a question the flow withdraws gives way to the step before it", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* makeSignIns();
        const withdraw = yield* Deferred.make<void>();
        const login = yield* Effect.forkChild(
          signIns.run("p", "oauth", (signIn) =>
            Effect.gen(function* () {
              signIn.show({ type: "browser", url: "https://auth.test/a" });
              // The browser came back first: the paste is no longer wanted.
              yield* Effect.raceFirst(signIn.ask({ type: "browser", url: "https://auth.test/a", paste: {} }), Deferred.await(withdraw));
              yield* Effect.never;
            }),
          ),
        );
        yield* until(signIns.list, (signIn) => signIn?.step.type === "browser" && signIn.step.paste !== undefined);
        yield* Deferred.succeed(withdraw, undefined);
        const back = yield* until(signIns.list, (signIn) => signIn?.step.type === "browser" && signIn.step.paste === undefined);
        expect(back?.step).toEqual({ type: "browser", url: "https://auth.test/a" });
        yield* Fiber.interrupt(login);
      }),
    ));

  test("shows what the flow says once a step is answered, or withdrawn, in place of the defaults", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* makeSignIns();
        const withdraw = yield* Deferred.make<void>();
        const login = yield* Effect.forkChild(
          signIns.run("p", "oauth", (signIn) =>
            Effect.gen(function* () {
              yield* signIn.ask({ type: "key", label: "P API key" }, { answered: { type: "working", message: "Checking the key" } });
              signIn.show({ type: "browser", url: "https://auth.test/a" });
              yield* Effect.raceFirst(
                signIn.ask({ type: "browser", url: "https://auth.test/a", paste: {} }, { withdrawn: { type: "working", message: "Finishing sign-in" } }),
                Deferred.await(withdraw),
              );
              yield* Effect.never;
            }),
          ),
        );
        const key = yield* until(signIns.list, (signIn) => signIn?.step.type === "key");
        yield* signIns.answer("p", key!.seq, "sk");
        expect(signIns.current()[0]?.step).toEqual({ type: "working", message: "Checking the key" });
        yield* until(signIns.list, (signIn) => signIn?.step.type === "browser" && signIn.step.paste !== undefined);
        yield* Deferred.succeed(withdraw, undefined);
        const after = yield* until(signIns.list, (signIn) => signIn?.step.type === "working" && signIn.step.message === "Finishing sign-in");
        expect(after?.seq).toBeGreaterThan(key!.seq);
        yield* Fiber.interrupt(login);
      }),
    ));

  test("numbers steps past those of an instance before it, so an answer for a replaced sign-in's step is refused", () =>
    run(
      Effect.gen(function* () {
        const first = yield* makeSignIns();
        const asked = yield* Effect.forkChild(first.run("p", "api_key", (signIn) => signIn.ask({ type: "key", label: "P API key" })));
        const old = yield* until(first.list, (signIn) => signIn?.step.type === "key");
        yield* Fiber.interrupt(asked);
        // A replacement, as a reload makes, asking the same.
        const second = yield* makeSignIns();
        const again = yield* Effect.forkChild(second.run("p", "api_key", (signIn) => signIn.ask({ type: "key", label: "P API key" })));
        const now = yield* until(second.list, (signIn) => signIn?.step.type === "key");
        expect(now!.seq).toBeGreaterThan(old!.seq);
        expect(failure(yield* Effect.exit(second.answer("p", old!.seq, "meant for the old one")))).toMatchObject({ reason: "NotAsked" });
        yield* Fiber.interrupt(again);
      }),
    ));

  test("says how each ended, a failure with its message, then stops listing it", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* makeSignIns({ endedListedMs: 20 });
        yield* Effect.exit(signIns.run("p", "api_key", () => Effect.fail(new Error("The key was refused"))));
        expect(signIns.current()).toMatchObject([{ provider: "p", ended: { outcome: "failed", message: "The key was refused" } }]);
        const cancelled = yield* Effect.forkChild(signIns.run("q", "oauth", () => Effect.never));
        yield* until(signIns.list, (signIn) => signIn !== undefined, "q");
        yield* Fiber.interrupt(cancelled);
        expect(signIns.current().find((signIn) => signIn.provider === "q")?.ended).toEqual({ outcome: "cancelled" });
        // Gone a moment later.
        yield* until(signIns.list, (signIn) => signIn === undefined, "q");
        expect(signIns.current()).toEqual([]);
      }),
    ));

  test("a new subscriber hears what is running now first", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* makeSignIns();
        const login = yield* Effect.forkChild(
          signIns.run("p", "oauth", (signIn) =>
            Effect.andThen(
              Effect.sync(() => signIn.show({ type: "code", code: "ABCD-1234", url: "https://x.test/device", expiresIn: 900 })),
              Effect.never,
            ),
          ),
        );
        yield* until(signIns.list, (signIn) => signIn?.step.type === "code");
        const first = yield* Stream.runHead(signIns.list);
        expect(Option.getOrThrow(first)).toMatchObject([{ provider: "p", step: { type: "code", code: "ABCD-1234" } }]);
        yield* Fiber.interrupt(login);
      }),
    ));
});
