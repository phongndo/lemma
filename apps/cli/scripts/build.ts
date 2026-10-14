/**
 * Bundles the `lemma` command into one file, `dist/lemma.mjs`, which starts in
 * a third of the time the sources take (agents run many commands). The host
 * stays out of it: `serve` loads `@lemma/host` from the workspace when it runs.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/lemma.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["lemma-source"],
  // jsonc-parser's main build is UMD, which loads its parts with a `require` a bundle cannot follow: its ES modules instead.
  mainFields: ["module", "main"],
  external: ["@lemma/host"],
  // Bundled CommonJS calls `require`, which an ES module has only through this.
  banner: { js: "import { createRequire as __lemmaRequire } from 'node:module'; const require = __lemmaRequire(import.meta.url);" },
  logLevel: "warning",
});
