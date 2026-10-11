import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Effect } from "effect";
import type { WebFile } from "@lemma/contracts";
import { projectPluginsDir } from "./config.ts";
import { entriesOf } from "./manifest.ts";
import type { PathsService } from "./paths.ts";

/** `<home>/plugins`: the user's plugins, both halves (see `manifest.ts`). */
export const userPluginsDir = (paths: PathsService): string => join(paths.home, "plugins");

/**
 * The files the web app loads from the plugin directories: web halves
 * (`notes.web.js`, a package's `lemma.web`) and stylesheets (`theme.css`, a
 * package's `lemma.styles`), the user's first, each directory by name. A
 * project's are listed only when it is trusted: they run in the browser with
 * the page's token. The URL carries the file's mtime, so an edited file is
 * fetched again rather than served from the module cache.
 */
export function listWebFiles(paths: PathsService, trusted: boolean): Effect.Effect<WebFile[]> {
  const dirs = [{ dir: userPluginsDir(paths), source: "user" as const }, ...(trusted ? [{ dir: projectPluginsDir(paths), source: "project" as const }] : [])];
  return Effect.promise(async () => {
    const files: WebFile[] = [];
    for (const { dir, source } of dirs) {
      const found = (await entriesOf(dir)).flatMap((entry): { readonly path: string; readonly kind: WebFile["kind"] }[] => {
        if (entry.kind === "web") return [{ path: entry.path, kind: "script" }];
        if (entry.kind === "style") return [{ path: entry.path, kind: "style" }];
        if (entry.kind !== "package") return [];
        const { web, styles = [] } = entry.manifest;
        return [...(web === undefined ? [] : [{ path: web, kind: "script" as const }]), ...styles.map((path) => ({ path, kind: "style" as const }))];
      });
      for (const { path, kind } of found) {
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile()) continue;
        const name = relative(dir, path);
        const url = `/api/web/${source}/${name.split("/").map(encodeURIComponent).join("/")}?v=${Math.round(info.mtimeMs)}`;
        files.push({ name, source, kind, path, url });
      }
    }
    return files;
  });
}
