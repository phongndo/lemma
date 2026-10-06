// The session log's hot path on the real disk: an append waits for its fdatasync, and a restarted host lists
// what it has. Absolute numbers depend on the disk; compare runs on one machine. Run: `pnpm sessions:bench`.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Duration, Effect } from "effect";
import { makeCore } from "@lemma/core";
import { Sessions } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { finish, record } from "../../../packages/core/bench/budgets.ts";
import sessions from "../src/index.ts";

const appends = Number(process.env.LEMMA_BENCH_APPENDS ?? 500);
const listed = Number(process.env.LEMMA_BENCH_SESSIONS ?? 200);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-bench-"));
const paths = pathsPlugin(dir);
const host = <A, E>(body: Effect.Effect<A, E, Sessions>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([paths, sessions]), (core) => core.run(body))));
const percentile = (values: readonly number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;

try {
  // Appends to one session, each durable before the next.
  const latencies = await host(
    Effect.gen(function* () {
      const store = yield* Sessions;
      const { id } = yield* store.create();
      const taken: number[] = [];
      for (let n = 0; n < appends; n++) {
        const start = performance.now();
        yield* store.append(id, { type: "custom", kind: "bench", data: { n, text: "x".repeat(200) } });
        taken.push(performance.now() - start);
      }
      return taken;
    }),
  );
  const total = latencies.reduce((sum, value) => sum + value, 0);
  record("sessionAppendsPerSecond", (appends * 1000) / total);
  record("sessionAppendP50Ms", percentile(latencies, 0.5));
  record("sessionAppendP99Ms", percentile(latencies, 0.99));

  // A restarted host listing many sessions: the first list reads them, the next is served by the index.
  await host(
    Effect.gen(function* () {
      const store = yield* Sessions;
      for (let n = 0; n < listed; n++) {
        const { id } = yield* store.create();
        yield* store.append(id, { type: "title", title: `session ${n}` });
      }
    }),
  );
  await fs.rm(path.join(dir, "sessions", ".index.json"), { force: true });
  const listing = () => host(Effect.flatMap(Sessions, (store) => Effect.map(Effect.timed(store.list()), ([taken]) => Duration.toMillis(taken))));
  const cold = await listing();
  const warm = await listing();
  record("sessionListColdMs", cold);
  record("sessionListWarmMs", warm);
  console.log(
    `${appends} appends: ${((appends * 1000) / total).toFixed(0)}/s, p50 ${percentile(latencies, 0.5).toFixed(2)} ms, p99 ${percentile(latencies, 0.99).toFixed(2)} ms; ` +
      `list of ${listed + 1}: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms`,
  );
  finish("sessions");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
