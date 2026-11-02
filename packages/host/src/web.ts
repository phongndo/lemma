import { stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { Effect } from "effect";
import { WEB_IMPORTABLE } from "@lemma/contracts";
import type { WebFile } from "@lemma/contracts";
import { projectPluginsDir } from "./config.ts";
import { entriesOf, folderVersion, webPluginOf } from "./manifest.ts";
import type { PathsService } from "./paths.ts";

/** `<home>/plugins`: the user's plugins, both halves (see `manifest.ts`). */
export const userPluginsDir = (paths: PathsService): string => join(paths.home, "plugins");

/** Whether a package's web half may import a file of it (`WEB_IMPORTABLE`): what its version is made from. */
const isWebImportable = (name: string) => WEB_IMPORTABLE.has(extname(name));

/**
 * The files the web app loads from the plugin directories: web halves (`notes.web.js`, a package's `lemma.web`) and
 * stylesheets (`theme.css`, a package's `lemma.styles`), the user's first, each directory by name. A project's are
 * listed only when it is trusted: they run in the browser with the page's token. The URL carries a version in its path
 * (`/api/web/<source>@<version>/<name>`): a file's mtime, or for a package those of the files its web half may import,
 * so an edited file is fetched again rather than served from the module cache, and so is a module a package's web half
 * imports by a relative path, which inherits the version (the transport serves those beside its listed files).
 */
export function listWebFiles(paths: PathsService, trusted: boolean): Effect.Effect<WebFile[]> {
  const dirs = [{ dir: userPluginsDir(paths), source: "user" as const }, ...(trusted ? [{ dir: projectPluginsDir(paths), source: "project" as const }] : [])];
  return Effect.promise(async () => {
    const files: WebFile[] = [];
    for (const { dir, source } of dirs) {
      const found = (await entriesOf(dir)).flatMap(
        (entry): { readonly path: string; readonly kind: WebFile["kind"]; readonly plugin?: string; readonly package?: string }[] => {
          if (entry.kind === "web") return [{ path: entry.path, kind: "script", plugin: webPluginOf(entry.name) }];
          if (entry.kind === "style") return [{ path: entry.path, kind: "style" }];
          if (entry.kind !== "package") return [];
          const { web, styles = [] } = entry.manifest;
          return [
            ...(web === undefined ? [] : [{ path: web, kind: "script" as const, plugin: entry.name, package: entry.path }]),
            ...styles.map((path) => ({ path, kind: "style" as const, plugin: entry.name, package: entry.path })),
          ];
        },
      );
      const versions = new Map<string, Promise<string>>();
      for (const { path, kind, plugin, package: folder } of found) {
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile()) continue;
        const name = relative(dir, path).split(sep).join("/");
        const version =
          folder === undefined
            ? String(Math.round(info.mtimeMs))
            : await (versions.get(folder) ?? versions.set(folder, folderVersion(folder, isWebImportable)).get(folder)!);
        const url = `/api/web/${source}@${version}/${name.split("/").map(encodeURIComponent).join("/")}`;
        files.push({ name, source, kind, path, url, ...(plugin === undefined ? {} : { plugin }) });
      }
    }
    return files;
  });
}
