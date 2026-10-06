import { describe, expect, test } from "vitest";
import { Effect, Layer } from "effect";
import { definePlugin, makeCore, PluginContext, Registries } from "@lemma/core";
import { FileSearchers, Inspectors, searchFiles, snapshotOf } from "../src/index.ts";
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
});
