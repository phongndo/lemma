/// <reference types="vitest/config" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
/**
 * Without `LEMMA_HOST_URL`, the host running on the checkout's home (`LEMMA_HOME`, which the root scripts default to
 * `~/.lemma-dev`), else `pnpm dev`'s port: never an installed Lemma's, on `~/.lemma` and 7433, whose sessions and
 * settings a development build leaves alone.
 */
const checkoutHost = (): string | undefined => {
  try {
    const entry: unknown = JSON.parse(readFileSync(join(process.env.LEMMA_HOME?.trim() || join(homedir(), ".lemma-dev"), "transport.json"), "utf8"));
    const url = typeof entry === "object" && entry !== null ? (entry as { url?: unknown }).url : undefined;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
};
const hostUrl = process.env.LEMMA_HOST_URL ?? checkoutHost() ?? "http://127.0.0.1:7434";
const token = process.env.LEMMA_HOST_TOKEN;
const auth = token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } };

const src = resolve(import.meta.dirname, "src");
const domains = resolve(import.meta.dirname, "../../domains");
const folders = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name));
/** The page's packages under domains/: those that draw, so depend on Solid (web plugins, web contracts), not the host's. */
const webPackages = folders(domains)
  .flatMap(folders)
  .filter((dir) => {
    if (!existsSync(join(dir, "package.json"))) return false;
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return "solid-js" in { ...manifest.dependencies, ...manifest.peerDependencies };
  })
  .map((dir) => join(dir, "src"));
/** Where the bundled plugins' source is: the app's own, the page's packages under domains/, and the plugin API. */
const sources = [src, ...webPackages, resolve(import.meta.dirname, "../../packages/web/src")];
const CANDIDATES = "virtual:lemma/utility-candidates";

/**
 * `virtual:lemma/utility-candidates`: the Tailwind classes the bundled
 * plugins' source uses, as the build finds them (`@source` in `src/tailwind.css`). The
 * page compiles them with web halves' classes into one sheet (`ui/utilities.ts`),
 * so a utility from a web half sorts among the app's own as one build would.
 */
function utilityCandidates(): Plugin {
  const id = `\0${CANDIDATES}`;
  const require = createRequire(import.meta.url);
  return {
    name: "lemma:utility-candidates",
    resolveId: (source) => (source === CANDIDATES ? id : undefined),
    async load(source) {
      if (source !== id) return undefined;
      const scanned = new Scanner({ sources: sources.map((base) => ({ base, pattern: "**/*", negated: false })) }).scan();
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
      if (!sources.some((dir) => file.startsWith(dir)) || file.includes("/node_modules/")) return;
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
