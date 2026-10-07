/// <reference types="vitest/config" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { Scanner } from "@tailwindcss/oxide";
import tailwindcss from "@tailwindcss/vite";
import { compile } from "tailwindcss";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

// Production: the host's transport plugin serves `dist`, `/rpc`, and `/api` from the same origin.
// Dev: `LEMMA_DEV_HOST` sets the bind address (default loopback), `LEMMA_HOST_URL` the host to proxy to,
// and `LEMMA_HOST_TOKEN`, when set, is sent on every proxied request, so the page works without `?token=`:
// anyone who can reach the dev server can then use the host.
const hostUrl = process.env.LEMMA_HOST_URL ?? "http://127.0.0.1:7433";
const token = process.env.LEMMA_HOST_TOKEN;
const auth = token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } };

const src = resolve(import.meta.dirname, "src");
const CANDIDATES = "virtual:lemma/utility-candidates";

/**
 * `virtual:lemma/utility-candidates`: the Tailwind classes the app's own
 * source uses, as the build finds them (`@source` in `src/tailwind.css`). The
 * page compiles them with UI files' classes into one sheet (`ui/utilities.ts`),
 * so a utility from a UI file sorts among the app's own as one build would.
 */
function utilityCandidates(): Plugin {
  const id = `\0${CANDIDATES}`;
  const require = createRequire(import.meta.url);
  return {
    name: "lemma:utility-candidates",
    resolveId: (source) => (source === CANDIDATES ? id : undefined),
    async load(source) {
      if (source !== id) return undefined;
      const scanned = new Scanner({ sources: [{ base: src, pattern: "**/*", negated: false }] }).scan();
      const compiler = await compile(await readFile(resolve(src, "tailwind.css"), "utf8"), {
        base: src,
        loadStylesheet: async (sheet, base) => {
          const path = sheet.startsWith(".") ? resolve(base, sheet) : require.resolve(sheet);
          return { path, base: dirname(path), content: await readFile(path, "utf8") };
        },
      });
      // Most of what the scanner finds is words, not utilities: keep those that add a rule.
      let size = compiler.build([]).length;
      const used = scanned.filter((candidate) => {
        const grown = compiler.build([candidate]).length;
        if (grown === size) return false;
        size = grown;
        return true;
      });
      return `export default ${JSON.stringify(used.sort())};`;
    },
    hotUpdate({ file }) {
      if (!file.startsWith(src)) return;
      const module = this.environment.moduleGraph.getModuleById(id);
      if (module !== undefined) this.environment.moduleGraph.invalidateModule(module);
    },
  };
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), utilityCandidates()],
  resolve: { conditions: ["lemma-source"] },
  server: {
    host: process.env.LEMMA_DEV_HOST ?? "127.0.0.1",
    proxy: { "/rpc": { target: hostUrl, ws: true, ...auth }, "/api": { target: hostUrl, ...auth } },
  },
  build: { target: "es2022", sourcemap: true },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
