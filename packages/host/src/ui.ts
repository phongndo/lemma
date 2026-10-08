import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { UiFile } from "@lemma/contracts";
import type { PathsService } from "./paths.ts";

/** `<home>/ui`: the user's web app plugins and stylesheets. */
export const userUiDir = (paths: PathsService): string => join(paths.home, "ui");
/** `<cwd>/.lemma/ui`: a trusted project's. */
export const projectUiDir = (paths: PathsService): string => join(dirname(paths.projectConfig), "ui");

const kindOf = (name: string): UiFile["kind"] | undefined => (/\.(js|mjs)$/.test(name) ? "script" : name.endsWith(".css") ? "style" : undefined);

/**
 * The files the web app loads, user files first, each directory by name. A
 * project's are listed only when it is trusted: they run in the browser with
 * the page's token. The URL carries the file's mtime, so an edited file is
 * fetched again rather than served from the module cache.
 */
export function listUiFiles(paths: PathsService, trusted: boolean): Effect.Effect<UiFile[]> {
  const dirs = [{ dir: userUiDir(paths), source: "user" as const }, ...(trusted ? [{ dir: projectUiDir(paths), source: "project" as const }] : [])];
  return Effect.promise(async () => {
    const files: UiFile[] = [];
    for (const { dir, source } of dirs) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.sort()) {
        const kind = kindOf(name);
        if (kind === undefined) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile()) continue;
        files.push({ name, source, kind, path, url: `/api/ui/${source}/${encodeURIComponent(name)}?v=${Math.round(info.mtimeMs)}` });
      }
    }
    return files;
  });
}
