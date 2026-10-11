import { registerHooks } from "node:module";

/**
 * Bare imports that a plugin file's own location cannot resolve (`effect`, `@lemma/core`, `@lemma/contracts`, a
 * domain's contract such as `@lemma/tools`) fall back to the host's packages, so a plugin file needs no install step
 * and shares the host's module instances. That is why the host's package.json lists every host domain's contract,
 * though it imports none.
 *
 * A plugin's own modules are versioned with it: its entry is imported as `<file>?lemma-v=<version>`, and its relative
 * imports carry the same version, so an edit to any file of a folder plugin loads them all again rather than the
 * module cache's.
 */
export const VERSION = "lemma-v";
let hooked = false;
export function shareHostPackages(): void {
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
