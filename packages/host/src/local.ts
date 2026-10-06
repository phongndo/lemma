import { readdir, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { Diagnostic } from "@lemma/core";
import type { Plugin } from "@lemma/core";

/**
 * Local plugins are `.ts`, `.js`, or `.mjs` files in `<home>/plugins` and, for a
 * trusted project, `<cwd>/.lemma/plugins`, whose default export is a plugin,
 * an array of plugins, or a function of `{ bundled }` (the bundled plugins by
 * id) returning either, so a replacement can wrap the bundled plugin it
 * replaces and keep its updates. They run with the host's permissions, like
 * every plugin.
 *
 * Bare imports that the file's own location cannot resolve (`effect`,
 * `@lemma/core`, `@lemma/contracts`) fall back to the host's packages, so a
 * plugin file needs no install step and shares the host's module instances.
 */
let hooked = false;
function shareHostPackages(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) throw error;
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
    },
  });
}

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
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.filter((file) => /\.(ts|js|mjs)$/.test(file) && !file.endsWith(".d.ts")).sort()) {
        const file = join(dir, name);
        shareHostPackages();
        try {
          // Keyed by mtime: an unchanged file returns the cached module (the same
          // definition, so a reload leaves it running); an edited file is re-imported.
          const { mtimeMs } = await stat(file);
          const url = `${pathToFileURL(file).href}?v=${mtimeMs}`;
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
          plugins.push(...found.map((plugin) => ({ plugin, dir })));
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
