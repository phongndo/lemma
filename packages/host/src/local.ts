import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { Diagnostic } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { entriesOf } from "./manifest.ts";

/**
 * Local plugins' host halves are `.ts`, `.js`, or `.mjs` files in `<home>/plugins`
 * and, for a trusted project, `<cwd>/.lemma/plugins` (not `.web.js`: those are
 * web halves), or a package's `lemma.host` (see `manifest.ts`), whose default
 * export is a plugin, an array of plugins, or a function of `{ bundled }` (the
 * bundled plugins by id) returning either, so a replacement can wrap the
 * bundled plugin it replaces and keep its updates. They run with the host's
 * permissions, like every plugin.
 *
 * Bare imports that the file's own location cannot resolve (`effect`,
 * `@lemma/core`, `@lemma/contracts`, a domain's contract such as
 * `@lemma/tools`) fall back to the host's packages, so a plugin file needs no
 * install step and shares the host's module instances. That is why the host's
 * package.json lists every host domain's contract, though it imports none.
 *
 * A plugin's own modules are versioned with it: its entry is imported as
 * `<file>?lemma-v=<version>`, and its relative imports carry the same version,
 * so an edit to any file of a folder plugin loads them all again rather than
 * the module cache's.
 */
const VERSION = "lemma-v";
let hooked = false;
function shareHostPackages(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = (() => {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) throw error;
          return nextResolve(specifier, { ...context, parentURL: import.meta.url });
        }
      })();
      const version = context.parentURL?.startsWith("file:") ? new URL(context.parentURL).searchParams.get(VERSION) : null;
      if (version === null || !specifier.startsWith(".") || !resolved.url.startsWith("file:")) return resolved;
      const url = new URL(resolved.url);
      url.searchParams.set(VERSION, version);
      return { ...resolved, url: url.href };
    },
  });
}

/** Every source file of a folder plugin, but its dependencies' and hidden ones: what its version is made from. */
const sourcesOf = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourcesOf(path)));
    else if (/\.(ts|mts|js|mjs|json)$/.test(entry.name)) found.push(path);
  }
  return found;
};

/** A plugin's version: its file's mtime, or, for a folder plugin, every source file's, so an edit to any is a new one. */
const versionOf = async (file: string, folder: string | undefined): Promise<string> => {
  if (folder === undefined) return String((await stat(file)).mtimeMs);
  const hash = createHash("sha256");
  for (const path of (await sourcesOf(folder)).sort()) hash.update(`${path}:${(await stat(path).catch(() => undefined))?.mtimeMs ?? 0}\n`);
  return hash.digest("hex").slice(0, 16);
};

/**
 * What each file version made, by its versioned URL: a function export runs
 * once per version, so a reload sees the same definitions and leaves them
 * running, as it does a plain export (the module cache keeps that one).
 */
const made = new Map<string, unknown>();

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === "object" && value !== null && typeof (value as Plugin).id === "string" && typeof (value as Plugin).layer === "function";

interface LocalPlugin {
  readonly plugin: Plugin;
  /** The directory in `dirs` the plugin's file was found in. */
  readonly dir: string;
  /** Where its code is: its file, or its package's folder (`CodeOwner`). */
  readonly code: string;
}

interface LocalPlugins {
  /** In `dirs` order, then by file name. */
  readonly plugins: readonly LocalPlugin[];
  readonly diagnostics: readonly Diagnostic[];
}

/** What a plugin file's default export receives when it is a function. */
interface LocalContext {
  /** The bundled plugins by id: a replacement can wrap one, delegating to it. */
  readonly bundled: Readonly<Record<string, Plugin>>;
}

export function loadLocalPlugins(dirs: readonly string[], context: LocalContext): Effect.Effect<LocalPlugins> {
  return Effect.promise(async () => {
    const plugins: LocalPlugin[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const dir of dirs) {
      const entries = await entriesOf(dir);
      for (const entry of entries) {
        if (entry.kind !== "package") continue;
        for (const problem of entry.problems) {
          diagnostics.push(new Diagnostic({ severity: "warning", pluginId: entry.name, message: `${entry.path}/package.json: ${problem}; it is left out` }));
        }
      }
      const files = entries.flatMap((entry): { readonly file: string; readonly folder?: string }[] =>
        entry.kind === "host"
          ? [{ file: entry.path }]
          : entry.kind === "package" && entry.manifest.host !== undefined
            ? [{ file: entry.manifest.host, folder: entry.path }]
            : [],
      );
      for (const { file, folder } of files) {
        shareHostPackages();
        try {
          // Keyed by version: an unchanged plugin returns the cached module (the same
          // definition, so a reload leaves it running); an edited one is re-imported.
          const url = `${pathToFileURL(file).href}?${VERSION}=${await versionOf(file, folder)}`;
          const module = await import(url);
          if (!made.has(url)) made.set(url, typeof module.default === "function" && !isPlugin(module.default) ? module.default(context) : module.default);
          const result = made.get(url);
          const exported: unknown[] = Array.isArray(result) ? result : [result];
          const found = exported.filter(isPlugin);
          if (found.length === 0) {
            diagnostics.push(
              new Diagnostic({ severity: "warning", message: `${file}: no plugin in the default export`, suggestion: "export default definePlugin({ ... })" }),
            );
          }
          plugins.push(...found.map((plugin) => ({ plugin, dir, code: folder ?? file })));
        } catch (cause) {
          diagnostics.push(
            new Diagnostic({
              severity: "error",
              message: `${file}: cannot load: ${cause instanceof Error ? cause.message : String(cause)}`,
              suggestion: "Fix the file or move it out of the plugins directory (`--safe` starts Lemma without plugin files)",
            }),
          );
        }
      }
    }
    return { plugins, diagnostics };
  });
}
