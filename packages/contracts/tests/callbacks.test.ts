import { EventEmitter, once } from "node:events";
import { describe, expect, test } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { definePlugin, fail, makeCore, PluginContext, Registries } from "@lemma/core";
import { elementsOf, FileSearchers, HostError, Inspectors, resultOf, searchFiles, serveChannel, snapshotOf } from "../src/index.ts";
import type { FileSearcher, Inspector } from "../src/index.ts";

/** Runs `body` in a core where one plugin contributed `searcher` and `inspectors`. */
const withContributions = <A>(searcher: FileSearcher, inspectors: readonly Inspector[], body: Effect.Effect<A, unknown, Registries>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const contributor = definePlugin({
          id: "contributor",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.add(FileSearchers, searcher);
              for (const inspector of inspectors) yield* owner.add(Inspectors, inspector);
            }),
          ),
        });
        const core = yield* makeCore([contributor]);
        return yield* core.run(body);
      }),
    ),
  );

describe("callbacks a plugin hands the contracts", () => {
  test("a file searcher may answer with a promise", async () => {
    const searcher: FileSearcher = { id: "plain", search: async (cwd, query) => ({ root: `${cwd}/${query}`, entries: [], truncated: false }) };
    const result = await withContributions(
      searcher,
      [],
      Effect.flatMap(Registries, (registries) => searchFiles(registries, "/w", "a.ts")),
    );
    expect(result).toEqual({ root: "/w/a.ts", entries: [], truncated: false });
  });

  test("an inspector's snapshot may be an Effect, or a function giving it at once, as a promise, or as an Effect", async () => {
    const inspectors: Inspector[] = [
      { id: "effect", title: "", snapshot: Effect.succeed("effect") },
      { id: "value", title: "", snapshot: () => "value" },
      { id: "promise", title: "", snapshot: async () => "promise" },
      { id: "lazy", title: "", snapshot: () => Effect.succeed("lazy") },
    ];
    const snapshots = await withContributions(
      { id: "none", search: () => Effect.die("unused") },
      inspectors,
      Effect.flatMap(Registries, (registries) =>
        Effect.flatMap(registries.items(Inspectors), (items) => Effect.forEach(items, (item) => snapshotOf(item.item))),
      ),
    );
    expect(snapshots).toEqual(["effect", "value", "promise", "lazy"]);
  });

  test("a channel's call may answer at once, with a promise, or with an Effect; its stream may be an async iterable", async () => {
    const declaration = { id: "plain.double", payload: Schema.Number, success: Schema.Number } as const;
    const calls = [
      serveChannel({ ...declaration, kind: "call" }, (n) => n * 2),
      serveChannel({ ...declaration, kind: "call" }, async (n) => n * 2),
      serveChannel({ ...declaration, kind: "call" }, (n) => Effect.succeed(n * 2)),
    ];
    expect(await Effect.runPromise(Effect.forEach(calls, (channel) => resultOf(channel, 21)))).toEqual([42, 42, 42]);

    const counting = serveChannel({ ...declaration, kind: "stream" }, async function* (to) {
      for (let n = 1; n <= to; n++) yield n;
    });
    expect(await Effect.runPromise(Stream.runCollect(elementsOf(counting, 3)))).toEqual([1, 2, 3]);
    // A throw promise code did not mark with `fail` is a defect, as from a promise; a marked one is the stream's failure.
    const broken = (error: unknown) =>
      serveChannel({ ...declaration, kind: "stream" }, async function* () {
        yield 1;
        throw error;
      });
    const unmarked = await Effect.runPromiseExit(Stream.runDrain(elementsOf(broken(new Error("bug")), 0)));
    expect(Exit.isFailure(unmarked) && Cause.hasDies(unmarked.cause)).toBe(true);
    const marked = await Effect.runPromiseExit(Stream.runDrain(elementsOf(broken(fail(new Error("expected"))), 0)));
    expect(Exit.isFailure(marked) && Cause.hasFails(marked.cause)).toBe(true);
  });

  test("a call hears its plugin leave: one that stops for it, an Effect or a promise, fails with its Withdrawn; one that takes no notice finishes", async () => {
    const declaration = { kind: "call", id: "plain.wait", payload: Schema.Void, success: Schema.String } as const;
    const withdrawn = new HostError({ code: "Withdrawn", subject: "plain.wait", message: "left" });
    const finish = Deferred.makeUnsafe<void>();
    /** Until `signal` aborts, at once if it has. */
    const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve())));
    const calls = [
      serveChannel(declaration, (_, { left }) => Effect.raceFirst(Effect.never, left)),
      // As `signal.throwIfAborted()` and `fetch` do: rejects with the signal's reason.
      serveChannel(declaration, async (_, { signal }) => {
        await aborted(signal);
        throw signal.reason;
      }),
      // As Node's timers and events do: rejects with an `AbortError` the reason caused.
      serveChannel(declaration, async (_, { signal }) => String(await once(new EventEmitter(), "never", { signal }))),
      serveChannel(declaration, () => Effect.as(Deferred.await(finish), "finished")),
      serveChannel(declaration, async (_, { signal }) => {
        await aborted(signal);
        throw fail(new Error("its own failure"));
      }),
    ];
    const outcomes = await Effect.runPromise(
      Effect.forEach(calls, (channel) =>
        Effect.gen(function* () {
          const leaves = yield* Deferred.make<void>();
          // Started at once, so it is waiting by the time its plugin leaves.
          const call = yield* Effect.forkChild(Effect.exit(resultOf(channel, undefined, { left: Deferred.await(leaves), withdrawn })), {
            startImmediately: true,
          });
          yield* Deferred.succeed(leaves, undefined);
          yield* Deferred.succeed(finish, undefined);
          const exit = yield* Fiber.join(call);
          return Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause);
        }),
      ),
    );
    expect(outcomes.slice(0, 3)).toEqual([withdrawn, withdrawn, withdrawn]);
    expect(outcomes[3]).toBe("finished");
    expect(outcomes[4]).toMatchObject({ message: "its own failure" });
    // Outside a host the plugin never leaves: the signal never aborts.
    expect(
      await Effect.runPromise(
        resultOf(
          serveChannel(declaration, (_, { signal }) => String(signal.aborted)),
          undefined,
        ),
      ),
    ).toBe("false");
  });

  test("a call's signal aborts when the call is interrupted, as a dropped client's is, with an AbortError rather than its Withdrawn, in a host or out of one", async () => {
    const declaration = { kind: "call", id: "plain.wait", payload: Schema.Void, success: Schema.String } as const;
    const withdrawn = new HostError({ code: "Withdrawn", subject: "plain.wait", message: "left" });
    const outcomes = await Effect.runPromise(
      Effect.forEach([{ left: Effect.never, withdrawn }, undefined], (served) =>
        Effect.gen(function* () {
          const reading = yield* Deferred.make<void>();
          const aborted = yield* Deferred.make<unknown>();
          // Reads its signal at once.
          const early = serveChannel(declaration, async (_, { signal }) => {
            signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.succeed(signal.reason)));
            Deferred.doneUnsafe(reading, Effect.void);
            return await new Promise<string>(() => {});
          });
          const call = yield* Effect.forkChild(resultOf(early, undefined, served), { startImmediately: true });
          yield* Deferred.await(reading);
          yield* Fiber.interrupt(call);
          // Reads it only once the call was interrupted, its promise still running: aborted already.
          const resume = yield* Deferred.make<void>();
          const late = yield* Deferred.make<boolean>();
          const later = serveChannel(declaration, async (_, lifetime) => {
            await Effect.runPromise(Deferred.await(resume));
            Deferred.doneUnsafe(late, Effect.succeed(lifetime.signal.aborted));
            return "late";
          });
          yield* Fiber.interrupt(yield* Effect.forkChild(resultOf(later, undefined, served), { startImmediately: true }));
          yield* Deferred.succeed(resume, undefined);
          return { reason: yield* Deferred.await(aborted), late: yield* Deferred.await(late) };
        }),
      ),
    );
    for (const { reason, late } of outcomes) {
      expect(reason).toMatchObject({ name: "AbortError" });
      expect(late).toBe(true);
    }
  });

  test("an inspector's snapshot method is called on its inspector", async () => {
    class Rows implements Inspector {
      readonly id = "rows";
      readonly title = "Rows";
      readonly rows = [{ n: 1 }];
      snapshot() {
        return this.rows;
      }
    }
    expect(await Effect.runPromise(snapshotOf(new Rows()))).toEqual([{ n: 1 }]);
  });
});
