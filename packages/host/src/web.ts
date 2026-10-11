import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Effect } from "effect";
import type { WebFile } from "@lemma/contracts";
import { compileWebHalf, isCompiled } from "./compile.ts";
import { projectPluginsDir } from "./config.ts";
import { entriesOf, webPluginOf } from "./manifest.ts";
import type { PathsService } from "./paths.ts";

/** `<home>/plugins`: the user's plugins, both halves (see `manifest.ts`). */
export const userPluginsDir = (paths: PathsService): string => join(paths.home, "plugins");

/** The web files, and the web halves that did not compile, with what went wrong (their module throws it in the page). */
export interface WebListing {
  readonly files: readonly WebFile[];
  readonly problems: readonly { readonly file: WebFile; readonly error: string }[];
}

/** What the last listing wrote to each compiled module, so an unchanged one is not written again. */
const written = new Map<string, string>();

/**
 * The files the web app loads from the plugin directories: web halves
 * (`notes.web.js`, a package's `lemma.web`) and stylesheets (`theme.css`, a
 * package's `lemma.styles`), the user's first, each directory by name. A
 * project's are listed only when it is trusted: they run in the browser with
 * the page's token. The URL carries the file's mtime, so an edited file is
 * fetched again rather than served from the module cache. A web half in
 * TypeScript is compiled (`compile.ts`) into `<home>/cache/web`, and its URL
 * carries a hash of what it compiled to, so a change to any of its files
 * fetches it again, and a change that compiles the same does not.
 */
export function listWebFiles(paths: PathsService, trusted: boolean): Effect.Effect<WebListing> {
  const dirs = [{ dir: userPluginsDir(paths), source: "user" as const }, ...(trusted ? [{ dir: projectPluginsDir(paths), source: "project" as const }] : [])];
  return Effect.promise(async () => {
    const files: WebFile[] = [];
    const problems: { file: WebFile; error: string }[] = [];
    for (const { dir, source } of dirs) {
      const found = (await entriesOf(dir)).flatMap((entry): { readonly path: string; readonly kind: WebFile["kind"]; readonly plugin?: string }[] => {
        if (entry.kind === "web") return [{ path: entry.path, kind: "script", plugin: webPluginOf(entry.name) }];
        if (entry.kind === "style") return [{ path: entry.path, kind: "style" }];
        if (entry.kind !== "package") return [];
        const { web, styles = [] } = entry.manifest;
        return [
          ...(web === undefined ? [] : [{ path: web, kind: "script" as const, plugin: entry.name }]),
          ...styles.map((path) => ({ path, kind: "style" as const, plugin: entry.name })),
        ];
      });
      for (const { path, kind, plugin } of found) {
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile()) continue;
        const name = relative(dir, path).split(sep).join("/");
        const at = `/api/web/${source}/${name.split("/").map(encodeURIComponent).join("/")}`;
        const named = plugin === undefined ? {} : { plugin };
        if (kind === "script" && isCompiled(path)) {
          const compiled = await compileWebHalf(path);
          const out = join(paths.home, "cache", "web", source, `${name}.js`);
          if (written.get(out) !== compiled.hash || !existsSync(out)) {
            await mkdir(dirname(out), { recursive: true });
            await writeFile(out, compiled.code);
            written.set(out, compiled.hash);
          }
          const file: WebFile = { name, source, kind, path, ...named, compiled: out, url: `${at}?v=${compiled.hash}` };
          files.push(file);
          if (!compiled.ok) problems.push({ file, error: compiled.error });
          continue;
        }
        files.push({ name, source, kind, path, ...named, url: `${at}?v=${Math.round(info.mtimeMs)}` });
      }
    }
    return { files, problems };
  });
}
