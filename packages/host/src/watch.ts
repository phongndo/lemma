import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Duration, Effect, Queue, Stream } from "effect";
import type { PathsService } from "./paths.ts";
import { projectUiDir, userUiDir } from "./ui.ts";

interface WatchOptions {
  /** Quiet period before a burst of changes becomes one emission. Default 250ms. */
  readonly debounceMs?: number;
}

/**
 * Emits the path of a config file after it changes, is created, or is removed.
 * Watches the containing directories rather than the files, because editors
 * replace files by rename and a project `.lemma` directory may not exist yet;
 * a directory that does not exist when the stream starts is not watched.
 */
export function watchConfig(paths: PathsService, options: WatchOptions = {}): Stream.Stream<string> {
  const targets = [...new Set([paths.userConfig, paths.projectConfig])];
  return Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watchers: FSWatcher[] = [];
        for (const target of targets) {
          const name = basename(target);
          try {
            const watcher = watch(dirname(target), (_, changed) => {
              if (changed === null || changed === name) Queue.offerUnsafe(queue, target);
            });
            // A watcher error (directory removed) ends this source; the host keeps running without it.
            watcher.on("error", () => {
              watcher.close();
            });
            watchers.push(watcher);
          } catch {
            // Directory absent: nothing to watch until the next start.
          }
        }
        return watchers;
      }),
      (watchers) =>
        Effect.sync(() => {
          for (const watcher of watchers) watcher.close();
        }),
    ),
  ).pipe(Stream.debounce(Duration.millis(options.debounceMs ?? 250)));
}

/**
 * Emits after a file in `<home>/ui` or the project's `.lemma/ui` changes. A
 * directory created while the host runs is picked up: its parent is watched
 * for it, and any change to that entry (created, removed, replaced) swaps in
 * a fresh watcher, since a removed directory's watcher on Linux goes quiet
 * without an error.
 */
export function watchUi(paths: PathsService, options: WatchOptions = {}): Stream.Stream<void> {
  const dirs = [userUiDir(paths), projectUiDir(paths)];
  return Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watchers = new Map<string, FSWatcher>();
        const attach = (path: string, onChange: (name: string | null) => void) => {
          if (watchers.has(path)) return;
          try {
            const watcher = watch(path, (_, name) => onChange(name));
            watcher.on("error", () => {
              watcher.close();
              watchers.delete(path);
            });
            watchers.set(path, watcher);
          } catch {
            // Absent: its parent's watcher attaches one when it appears.
          }
        };
        for (const dir of dirs) {
          const watchDir = () => {
            watchers.get(dir)?.close();
            watchers.delete(dir);
            attach(dir, () => Queue.offerUnsafe(queue, undefined));
          };
          attach(dirname(dir), (name) => {
            if (name !== null && name !== basename(dir)) return;
            watchDir();
            Queue.offerUnsafe(queue, undefined);
          });
          watchDir();
        }
        return watchers;
      }),
      (watchers) =>
        Effect.sync(() => {
          for (const watcher of watchers.values()) watcher.close();
        }),
    ),
  ).pipe(Stream.debounce(Duration.millis(options.debounceMs ?? 250)));
}
