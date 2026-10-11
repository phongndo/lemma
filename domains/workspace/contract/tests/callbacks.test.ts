import { describe, expect, test } from "vitest";
import { Effect, Layer } from "effect";
import { definePlugin, makeCore, PluginContext, Registries } from "@lemma/core";
import { FileSearchers, searchFiles } from "../src/files.ts";
import type { FileSearcher } from "../src/files.ts";

/** Runs `body` in a core where one plugin contributed `searcher`. */
const withSearcher = <A>(searcher: FileSearcher, body: Effect.Effect<A, unknown, Registries>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const contributor = definePlugin({
          id: "contributor",
          layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(FileSearchers, searcher))),
        });
        const core = yield* makeCore([contributor]);
        return yield* core.run(body);
      }),
    ),
  );

describe("callbacks a plugin hands the workspace contract", () => {
  test("a file searcher may answer with a promise", async () => {
    const searcher: FileSearcher = { id: "plain", search: async (cwd, query) => ({ root: `${cwd}/${query}`, entries: [], truncated: false }) };
    const result = await withSearcher(
      searcher,
      Effect.flatMap(Registries, (registries) => searchFiles(registries, "/w", "a.ts")),
    );
    expect(result).toEqual({ root: "/w/a.ts", entries: [], truncated: false });
  });
});
