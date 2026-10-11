import { describe, test } from "vitest";
import { mkdtemp, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Schedule, Stream } from "effect";
import { resolvePaths } from "../src/paths.ts";
import { userPluginsDir } from "../src/ui.ts";
import { watchConfig, watchPlugins } from "../src/watch.ts";

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

describe("watchPlugins", () => {
  test("picks up a plugins directory created after it started, then changes inside it, a package's too", async () => {
    const root = await mkdtemp(join(tmpdir(), "lemma-watch-plugins-"));
    try {
      const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
      await mkdir(paths.home, { recursive: true });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            let seen = 0;
            yield* Effect.forkChild(Stream.runForEach(watchPlugins(paths, { debounceMs: 50 }), () => Effect.sync(() => seen++)));
            yield* Effect.sleep(Duration.millis(50));
            // Each change waits for its own report, so the directory's watcher is attached before what is written in it.
            const reported = (change: () => Promise<unknown>) =>
              Effect.gen(function* () {
                const before = seen;
                yield* Effect.promise(change);
                yield* Effect.repeat(
                  Effect.sync(() => seen > before),
                  { until: (found) => found, schedule: Schedule.spaced(Duration.millis(20)) },
                ).pipe(Effect.timeout(Duration.seconds(5)));
              });
            yield* reported(() => mkdir(join(userPluginsDir(paths), "ticker"), { recursive: true }));
            yield* reported(() => writeFile(join(userPluginsDir(paths), "theme.css"), ":root { --accent: red; }"));
            yield* reported(() => writeFile(join(userPluginsDir(paths), "ticker", "web.js"), "export default () => [];"));
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("watchPlugins keeps watching a plugins directory that is removed and created again", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-watch-plugins-"));
  try {
    const paths = resolvePaths({ env: { LEMMA_HOME: join(root, "home") }, cwd: join(root, "project") });
    await mkdir(userPluginsDir(paths), { recursive: true });
    const settle = Effect.sleep(Duration.millis(150));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen: number[] = [];
          yield* Effect.forkChild(Stream.runForEach(watchPlugins(paths, { debounceMs: 50 }), () => Effect.sync(() => seen.push(Date.now()))));
          yield* Effect.sleep(Duration.millis(50));
          yield* Effect.promise(() => rmdir(userPluginsDir(paths)));
          yield* settle;
          yield* Effect.promise(() => mkdir(userPluginsDir(paths)));
          yield* settle;
          const before = seen.length;
          yield* Effect.promise(() => writeFile(join(userPluginsDir(paths), "theme.css"), ":root {}"));
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
