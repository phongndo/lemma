import { registerHooks } from "node:module";

/**
 * For `lemma plugins test` (`node --import`): what a plugin's tests import that their folder cannot resolve comes from
 * the host's packages, as the host gives its plugin files (`effect`, `@lemma/core`, a domain's contract), else from
 * this CLI's (`@lemma/test-host`).
 */
const bases = [import.meta.resolve("@lemma/host/paths"), import.meta.url];

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) throw error;
      for (const parentURL of bases) {
        try {
          return nextResolve(specifier, { ...context, parentURL });
        } catch {
          // The next base, or the first failure.
        }
      }
      throw error;
    }
  },
});
