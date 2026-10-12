import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Inspectors } from "@lemma/contracts";
import { Tools } from "@lemma/tools";
import { makeIndexes } from "./indexes.ts";
import { findTool, grepTool } from "./tools.ts";

export { makeIndexes, openFff } from "./indexes.ts";
export type { Finder, Indexes, OpenFinder } from "./indexes.ts";
export { findTool, grepTool, FindInput, GrepInput, GREP_TIME_BUDGET_MS, SCAN_WAIT_MS } from "./tools.ts";
export type { SearchDetails } from "./tools.ts";

export const SearchConfig = Schema.Struct({
  idleMinutes: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 24 * 60 }))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 15)))
    .annotate({
      title: "Keep an index for",
      description: "Minutes (1 to 1440) a directory's index stays in memory after its last search; the next search opens it again.",
    }),
});

/** The `grep` and `find` tools, over an fff index per directory searched. */
export default definePlugin({
  id: "tools.search-fff",
  version: "0.1.0",
  config: SearchConfig,
  setup: function* (_, owner) {
    const indexes = makeIndexes({ idleMs: owner.config.idleMinutes * 60_000 });
    yield* Effect.addFinalizer(() => Effect.sync(indexes.close));
    yield* owner.add(Tools, grepTool(indexes));
    yield* owner.add(Tools, findTool(indexes));
    yield* owner
      .add(Inspectors, {
        id: "tools.search-fff.indexes",
        title: "Search tool indexes",
        description: "Open indexes: files read, whether a scan is running, calls using it, and seconds since the last one ended",
        snapshot: indexes.snapshot,
      })
      .pipe(Effect.ignore);
  },
});
