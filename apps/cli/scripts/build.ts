/**
 * Bundles the `lemma` command into one file, `dist/lemma.mjs`, which starts in
 * half the time the sources take (agents run many commands), and lists
 * in `dist/lemma.json` the files it was built from, each with its size and
 * modification time, so that `bin/lemma.js` runs it only while they are
 * unchanged. Those are the workspace's sources it bundles and their packages'
 * manifests, `pnpm-lock.yaml` for what `node_modules` holds, and this script.
 * The host stays out of it: `serve` loads `@lemma/host` from the workspace when
 * it runs. `node scripts/build.ts [outdir]` writes elsewhere than `dist/`.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Loader } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outdir = resolve(process.argv[2] ?? join(root, "dist"));
const LOADERS: Readonly<Record<string, Loader>> = { ".ts": "ts", ".mts": "ts", ".js": "js", ".mjs": "js", ".json": "json" };

/** Each workspace file bundled, with its size and modification time from before it was read: an edit meanwhile is newer. */
const files = new Map<string, readonly [number, number]>();
const record = (path: string) => {
  const { size, mtimeMs } = statSync(path);
  files.set(path, [size, mtimeMs]);
};

const result = await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(outdir, "lemma.mjs"),
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["lemma-source"],
  // jsonc-parser's main build is UMD, which loads its parts with a `require` a bundle cannot follow: its ES modules instead.
  mainFields: ["module", "main"],
  // Bundled CommonJS calls `require`, which an ES module has only through this.
  banner: { js: "import { createRequire as __lemmaRequire } from 'node:module'; const require = __lemmaRequire(import.meta.url);" },
  logLevel: "warning",
  plugins: [
    {
      name: "lemma-inputs",
      setup: (bundler) =>
        bundler.onLoad({ filter: /.*/ }, async ({ path }) => {
          const loader = LOADERS[extname(path)];
          // A dependency is what pnpm-lock.yaml pins.
          if (/[\\/]node_modules[\\/]/.test(path) || loader === undefined) return undefined;
          const handle = await open(path);
          try {
            const { size, mtimeMs } = await handle.stat();
            files.set(path, [size, mtimeMs]);
            return { contents: await handle.readFile(), loader };
          } finally {
            await handle.close();
          }
        }),
    },
  ],
});

/** The package a file is in: the nearest folder above it with a manifest, whose `exports` and conditions resolved it. */
const manifestOf = (file: string): string | undefined => {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, "package.json"))) return join(dir, "package.json");
  return undefined;
};
const manifests = new Set([...files.keys()].map(manifestOf));
for (const manifest of manifests) if (manifest !== undefined && !files.has(manifest)) record(manifest);
record(resolve(root, "../../pnpm-lock.yaml"));
record(fileURLToPath(import.meta.url));

/** Written whole or not at all: a command starting meanwhile runs the old bundle or the new one. */
const replace = async (path: string, contents: string | Uint8Array) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
};
await mkdir(outdir, { recursive: true });
await replace(join(outdir, "lemma.mjs"), result.outputFiles[0]!.contents);
// The list last, so that the one a command reads is never newer than the bundle it runs.
const listed = [...files].map(([path, stamp]) => [relative(outdir, path), stamp] as const).sort((a, b) => a[0].localeCompare(b[0]));
await replace(join(outdir, "lemma.json"), `${JSON.stringify({ files: Object.fromEntries(listed) }, null, 2)}\n`);
