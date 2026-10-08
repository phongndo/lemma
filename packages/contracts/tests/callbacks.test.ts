import { describe, expect, test } from "vitest";
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect";
import { definePlugin, fail, makeCore, PluginContext, Registries } from "@lemma/core";
import { elementsOf, FileSearchers, Inspectors, resultOf, searchFiles, serveChannel, snapshotOf } from "../src/index.ts";
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
