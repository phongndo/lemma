import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Fiber, Schedule, Stream } from "effect";
import { resolvePaths, userUiDir, watchConfig, watchUi } from "../src/index.ts";

describe("watchConfig", () => {
  test("emits the changed file after a quiet period, for creation and later edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-watch-"));
    try {
      const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
      await mkdir(paths.home, { recursive: true });
      await mkdir(join(paths.cwd, ".lemma"), { recursive: true });
      await writeFile(paths.userConfig, "{}");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const seen: string[] = [];
            yield* Effect.forkChild(Stream.runForEach(watchConfig(paths, { debounceMs: 50 }), (path) => Effect.sync(() => seen.push(path))));
            // Let the watchers attach before writing.
            yield* Effect.sleep(Duration.millis(50));
            // Each write waits for its own report, after it: macOS can also report the user config's first write, made
            // before the watch started.
            const reported = (path: string, contents: string) =>
              Effect.gen(function* () {
                const from = seen.length;
                yield* Effect.promise(() => writeFile(path, contents));
                yield* Effect.repeat(
                  Effect.sync(() => seen.includes(path, from)),
                  { until: (found) => found, schedule: Schedule.spaced(Duration.millis(20)) },
                ).pipe(Effect.timeout(Duration.seconds(5)));
              });
            yield* reported(paths.projectConfig, `{ "plugins": {} }`);
            yield* reported(paths.userConfig, `{ "plugins": { "x": {} } }`);
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("watchUi", () => {
  test("picks up a ui directory created after it started, then changes inside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-watch-ui-"));
    try {
      const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
      await mkdir(paths.home, { recursive: true });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(watchUi(paths, { debounceMs: 50 }), 2)));
            yield* Effect.sleep(Duration.millis(50));
            yield* Effect.promise(() => mkdir(userUiDir(paths)));
            yield* Effect.sleep(Duration.millis(150));
            yield* Effect.promise(() => writeFile(join(userUiDir(paths), "theme.css"), ":root { --accent: red; }"));
            const changes = yield* Fiber.join(seen).pipe(Effect.timeout(Duration.seconds(5)));
            expect(changes.length).toBe(2);
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("watchUi keeps watching a ui directory that is removed and created again", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-watch-ui-"));
  try {
    const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
    await mkdir(userUiDir(paths), { recursive: true });
    const settle = Effect.sleep(Duration.millis(150));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen: number[] = [];
          yield* Effect.forkChild(Stream.runForEach(watchUi(paths, { debounceMs: 50 }), () => Effect.sync(() => seen.push(Date.now()))));
          yield* Effect.sleep(Duration.millis(50));
          yield* Effect.promise(() => rmdir(userUiDir(paths)));
          yield* settle;
          yield* Effect.promise(() => mkdir(userUiDir(paths)));
          yield* settle;
          const before = seen.length;
          yield* Effect.promise(() => writeFile(join(userUiDir(paths), "theme.css"), ":root {}"));
          yield* Effect.repeat(
            Effect.sync(() => seen.length),
            { until: (count) => count > before, schedule: Schedule.spaced(Duration.millis(20)) },
          ).pipe(Effect.timeout(Duration.seconds(5)));
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
