import { readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * How a process that runs the host starts (`start.mjs`, and `lemma serve`, whose process the host runs in): with
 * Effect from the host's bundle of it. JavaScript, as it loads before Node's compile cache is on, for which TypeScript
 * would load the type stripper (see start.mjs). Its types are in launch.d.mts.
 */

let used = false;

/**
 * Loads Effect from the host's bundle of it (`scripts/bundle-effect.ts`, which `pnpm build` runs) rather than from
 * its hundreds of modules. Every module of `effect` and the `@effect/*` packages, however it is imported (any
 * specifier, `import` or `require`, by the host or a plugin file), resolves to its entry in the bundle, so there is
 * one copy of each. A bundle that is missing, or was built from other packages or another version of the script, is
 * not used: Effect loads from its modules, as without one. Call it before anything imports Effect, whose modules
 * loaded before would be a second copy. Returns whether the bundle is used.
 */
export function useEffectBundle(cache = fileURLToPath(new URL("../node_modules/.cache/effect", import.meta.url))) {
  if (used) return true;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(cache, "effect.json"), "utf8"));
    if (realpathSync(fileURLToPath(new URL("../node_modules/effect", import.meta.url))) !== manifest.effect) return false;
    for (const [path, [size, mtimeMs]] of Object.entries(manifest.inputs)) {
      const now = statSync(path);
      if (now.size !== size || now.mtimeMs !== mtimeMs) return false;
    }
  } catch {
    return false;
  }
  const base = `${pathToFileURL(cache).href}/`;
  // By each package's directory, its modules by their path in it.
  const packages = Object.entries(manifest.packages).map(([dir, modules]) => [`${pathToFileURL(dir).href}/`, new Map(Object.entries(modules))]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      for (const [prefix, modules] of packages) {
        if (!resolved.url.startsWith(prefix)) continue;
        const entry = modules.get(resolved.url.slice(prefix.length));
        return entry === undefined ? resolved : { url: base + entry, format: "module", shortCircuit: true };
      }
      return resolved;
    },
  });
  used = true;
  return true;
}
