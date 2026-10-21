/// <reference types="vitest/config" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
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

/** What `precompress` compresses: the build's text, but its source maps, which only devtools fetch. */
const COMPRESSIBLE = /\.(?:js|css|html|svg|json|txt|wasm)$/;
const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/**
 * Writes `<file>.br` and `<file>.gz` beside each file of the build that is text of 1 KiB or more, where they come out
 * smaller. `transport.server` sends the copy a browser accepts, so the page's first load crosses as about a quarter of
 * its bytes, with nothing compressed as it is served. Brotli's quality 10 adds about a second to the build, in the
 * threads `node:zlib` runs it on; its best, 11, makes the first load 2% smaller and adds three.
 */
function precompress(): Plugin {
  return {
    name: "lemma:precompress",
    apply: "build",
    async writeBundle({ dir }, bundle) {
      if (dir === undefined) return;
      await Promise.all(
        Object.keys(bundle)
          .filter((name) => COMPRESSIBLE.test(name))
          .map(async (name) => {
            const path = join(dir, name);
            const data = await readFile(path);
            if (data.length < 1024) return;
            const [br, gz] = await Promise.all([
              brotli(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 10, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }),
              gzipped(data, { level: zlib.Z_BEST_COMPRESSION }),
            ]);
            await Promise.all([
              br.length < data.length ? writeFile(`${path}.br`, br) : undefined,
              gz.length < data.length ? writeFile(`${path}.gz`, gz) : undefined,
            ]);
          }),
      );
    },
  };
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), utilityCandidates(), precompress()],
  resolve: { conditions: ["lemma-source"] },
  server: {
    host: process.env.LEMMA_DEV_HOST ?? "127.0.0.1",
    proxy: { "/rpc": { target: hostUrl, ws: true, ...auth }, "/api": { target: hostUrl, ...auth } },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // An image (a provider's logo) is a file of its own, loaded where it shows, rather than text in the script every page loads.
    assetsInlineLimit: (file) => (file.endsWith(".svg") ? false : undefined),
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
