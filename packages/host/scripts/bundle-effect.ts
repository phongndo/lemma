/**
 * Bundles Effect for the host, which loads it from the bundle rather than from its hundreds of modules
 * (`useEffectBundle` in `src/launch.mjs`; the host's README, "Its start"): `effect` and every `@effect/*` package
 * installed with it. Each module any specifier they export resolves to is an entry of one build, so their code splits
 * into chunks they share and a module of theirs exists once, whoever imports it; their other imports stay where
 * Node.js resolves them from the module that imports them. It writes `<cache>/<key>/`, named for what it is built
 * from, and then `<cache>/effect.json`, which names it, says which modules it holds, and records each package's manifest
 * and this script with their sizes and modification times, so that the host uses it only while they are unchanged. A
 * build that is fresh is left as it is. The last few builds are kept, since a running host loads what it imports later
 * from the one it started with.
 *
 * `node --conditions=lemma-source scripts/bundle-effect.ts [cache]`; the cache is `node_modules/.cache/effect` by default.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin, registerHooks } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "esbuild";

const HOST = fileURLToPath(new URL("..", import.meta.url));
const cache = resolve(process.argv[2] ?? join(HOST, "node_modules/.cache/effect"));
const script = fileURLToPath(import.meta.url);
/** Builds kept beside the current one. */
const KEPT = 2;

// What Node.js resolves a specifier to from any module (this process runs with the host's conditions): asked through
// a hook, as `import.meta.resolve` resolves only from this one.
const ASK = "lemma-resolve:";
registerHooks({
  resolve: (specifier, context, next) => {
    if (!specifier.startsWith(ASK)) return next(specifier, context);
    const { asked, from } = JSON.parse(specifier.slice(ASK.length)) as { asked: string; from: string };
    return next(asked, { ...context, parentURL: from });
  },
});
const attempt = <A>(run: () => A, otherwise: A): A => {
  try {
    return run();
  } catch {
    return otherwise;
  }
};
const resolveFrom = (specifier: string, parentURL: string): string | undefined =>
  attempt(() => import.meta.resolve(ASK + JSON.stringify({ asked: specifier, from: parentURL })), undefined);

const effect = realpathSync(join(HOST, "node_modules/effect"));
/** Within a package's directory. */
const within = (file: string, dir: string) => file.startsWith(dir + sep);

/** The `@effect/*` packages installed: pnpm keeps each in its store beside effect's, a flat install beside it. */
const effectPackages = (): string[] => {
  const store = dirname(dirname(dirname(effect)));
  const stored =
    basename(store) === ".pnpm"
      ? attempt(() => readdirSync(store), [])
          .filter((entry) => entry.startsWith("@effect+"))
          .map((entry) => join(store, entry, "node_modules/@effect", entry.slice("@effect+".length).replace(/@.*$/, "")))
      : [];
  const flat = join(dirname(effect), "@effect");
  const beside = attempt(() => readdirSync(flat), []).map((name) => join(flat, name));
  return [...new Set([...stored, ...beside].flatMap((dir) => attempt(() => [realpathSync(dir)], [])))].sort();
};

interface Package {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
}

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { readonly name: string; readonly version: string; readonly exports?: unknown };

/** effect, and each `@effect/*` package whose own `effect` is this one: one bound to another copy keeps its own. */
const packages: Package[] = [effect, ...effectPackages()].flatMap((dir) => {
  const { name, version } = manifestOf(dir);
  if (dir !== effect) {
    const its = resolveFrom("effect", pathToFileURL(join(dir, "package.json")).href);
    if (its === undefined || !its.startsWith("file:") || !within(fileURLToPath(its), effect)) {
      console.log(`bundle-effect: leaving out ${name}@${version}, which imports another copy of effect`);
      return [];
    }
  }
  return [{ dir, name, version }];
});

/** Every file in a package, relative to it, but its dependencies'. */
const filesOf = (dir: string, under = ""): string[] =>
  readdirSync(join(dir, under), { withFileTypes: true }).flatMap((entry) => {
    const path = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesOf(dir, path);
    return [path];
  });

/** The string targets of an `exports` entry, under any condition. */
const targetsOf = (target: unknown): string[] =>
  typeof target === "string"
    ? [target]
    : Array.isArray(target)
      ? target.flatMap(targetsOf)
      : typeof target === "object" && target !== null
        ? Object.values(target).flatMap(targetsOf)
        : [];

/**
 * Every specifier a package may export: its `exports` keys, each pattern expanded over the files its targets match.
 * Node.js then says which resolve, and to what, so blocked subpaths, conditions, and precedence are its own.
 */
const specifiersOf = ({ dir, name }: Package): string[] => {
  const { exports } = manifestOf(dir);
  const map =
    typeof exports === "object" && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? (exports as Record<string, unknown>)
      : { ".": exports };
  const files = filesOf(dir).map((file) => `./${file}`);
  const subpaths = new Set<string>();
  for (const [key, target] of Object.entries(map)) {
    if (!key.includes("*")) {
      subpaths.add(key);
      continue;
    }
    for (const pattern of targetsOf(target)) {
      const [before, after = ""] = pattern.split("*") as [string, string?];
      for (const file of files) {
        if (file.length < before.length + after.length || !file.startsWith(before) || !file.endsWith(after)) continue;
        subpaths.add(key.replace("*", file.slice(before.length, file.length - after.length)));
      }
    }
  }
  return [...subpaths].map((subpath) => (subpath === "." ? name : `${name}${subpath.slice(1)}`));
};

/** Each package's modules its specifiers resolve to, by path within it, with the name of their entry. */
const entries = new Map<string, Map<string, string>>(packages.map(({ dir }) => [dir, new Map()]));
for (const pkg of packages) {
  // As a module beside the package resolves it: from outside, as its dependents do.
  const from = pathToFileURL(join(pkg.dir.slice(0, pkg.dir.length - pkg.name.length), "..", "importer.mjs")).href;
  for (const specifier of specifiersOf(pkg)) {
    const url = resolveFrom(specifier, from);
    if (url === undefined || !url.startsWith("file:")) continue;
    const file = fileURLToPath(url);
    if (!within(file, pkg.dir) || !/\.(m?js|cjs)$/.test(file)) continue;
    const named = entries.get(pkg.dir)!;
    const path = relative(pkg.dir, file).split(sep).join("/");
    // Named by its path in the package, which no other module's shares (as a specifier may, but for case).
    named.set(path, `${pkg.name}/${path.replace(/\.(m?js|cjs)$/, "")}`);
  }
}

/** Each input's size and modification time: the host uses the build while they are unchanged. */
const stamp = (path: string) => {
  const { size, mtimeMs } = statSync(path);
  return [size, mtimeMs] as const;
};
const inputs = Object.fromEntries([...packages.map(({ dir }) => join(dir, "package.json")), script].map((path) => [path, stamp(path)]));
const key = createHash("sha256")
  .update(JSON.stringify({ packages: packages.map(({ dir, version }) => [dir, version]), script: readFileSync(script, "utf8") }))
  .digest("hex")
  .slice(0, 16);
const manifestPath = join(cache, "effect.json");

interface Manifest {
  readonly dir: string;
  readonly effect: string;
  readonly inputs: Readonly<Record<string, readonly [number, number]>>;
  /** By package directory, each module's path in it and its entry's file in the build. */
  readonly packages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const current = attempt(() => JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest, undefined);
const fresh =
  current !== undefined &&
  current.dir === key &&
  current.effect === effect &&
  JSON.stringify(Object.keys(current.packages).sort()) === JSON.stringify(packages.map(({ dir }) => dir).sort()) &&
  Object.entries(inputs).every(([path, [size, mtimeMs]]) => current.inputs[path]?.[0] === size && current.inputs[path]?.[1] === mtimeMs);

/** Each module to bundle, by its path. */
const modules = [...entries].flatMap(([dir, named]) => [...named].map(([path, out]) => ({ file: join(dir, path), out })));
const bundled = (file: string) => packages.some(({ dir }) => within(file, dir));

/**
 * Imports of packages other than Effect's are left to Node.js, from where they are now: each as the file it resolves
 * to there. `workspace` also follows imports into this workspace's sources (to trace the host's start).
 */
const nodeResolution = (workspace: boolean): Plugin => ({
  name: "node-resolution",
  setup: (bundler) =>
    bundler.onResolve({ filter: /^[^./]/ }, ({ path, importer, kind }) => {
      if (kind === "entry-point" || path.startsWith("lemma-")) return undefined;
      if (isBuiltin(path)) return { path, external: true };
      const url = resolveFrom(path, pathToFileURL(importer).href);
      // What resolves nowhere fails where it is imported, as it would have.
      if (url === undefined) return { path, external: true };
      if (!url.startsWith("file:")) return { path: url, external: true };
      const file = fileURLToPath(url);
      if (bundled(file) || (workspace && !file.includes(`${sep}node_modules${sep}`))) return { path: file };
      return { path: url, external: true };
    }),
});

/**
 * The modules of Effect a host loads as it starts, in the order Node.js runs them: what `src/main.ts` imports, through
 * the workspace's sources, but for what they import only as they need it (`import()`). None when it cannot be told.
 */
const startup = async (): Promise<string[]> => {
  const { metafile } = await build({
    entryPoints: [join(HOST, "src/main.ts")],
    absWorkingDir: HOST,
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    platform: "node",
    metafile: true,
    logLevel: "silent",
    plugins: [nodeResolution(true)],
  });
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (input: string) => {
    if (seen.has(input)) return;
    seen.add(input);
    for (const imported of metafile.inputs[input]?.imports ?? []) if (imported.kind === "import-statement" && !imported.external) visit(imported.path);
    const file = resolve(HOST, input);
    if (bundled(file)) order.push(file);
  };
  visit("src/main.ts");
  return order;
};

// A build of these inputs is all there once it has its name (`<key>`), and stays as it is: a host may be loading from it.
if (!fresh && !existsSync(join(cache, key))) {
  const loaded = await startup().catch((error: unknown) => {
    console.log(`bundle-effect: cannot tell what a host loads as it starts, so each module is its own chunk: ${String(error)}`);
    return [];
  });
  // Which modules export a default, which `export *` leaves out.
  const analysis = await build({
    entryPoints: modules.map(({ file }) => file),
    absWorkingDir: HOST,
    write: false,
    outdir: "out",
    format: "esm",
    platform: "node",
    metafile: true,
    logLevel: "silent",
  });
  const withDefault = new Set(
    Object.values(analysis.metafile.outputs).flatMap(({ entryPoint, exports }) =>
      entryPoint !== undefined && exports.includes("default") ? [resolve(HOST, entryPoint)] : [],
    ),
  );
  /*
   * Each module's entry imports first all a host loads as it starts, so those modules share one chunk, loaded as one:
   * split by which entries reach them, they were hundreds. A module only some entries reach is in chunks of its own.
   */
  const entryPoints: Plugin = {
    name: "entry-points",
    setup: (bundler) => {
      bundler.onResolve({ filter: /^lemma-entry:/ }, ({ path }) => ({ path: path.slice("lemma-entry:".length), namespace: "lemma-entry" }));
      bundler.onLoad({ filter: /.*/, namespace: "lemma-entry" }, ({ path }) => ({
        contents: [
          `import "lemma-startup";`,
          `export * from ${JSON.stringify(`lemma-module:${path}`)};`,
          ...(withDefault.has(path) ? [`export { default } from ${JSON.stringify(`lemma-module:${path}`)};`] : []),
        ].join("\n"),
        loader: "js",
      }));
      bundler.onResolve({ filter: /^lemma-startup$/ }, () => ({ path: "startup", namespace: "lemma-startup" }));
      bundler.onLoad({ filter: /.*/, namespace: "lemma-startup" }, () => ({
        contents: loaded.map((file) => `import ${JSON.stringify(`lemma-module:${file}`)};`).join("\n"),
        loader: "js",
      }));
      bundler.onResolve({ filter: /^lemma-module:/ }, ({ path }) => ({ path: path.slice("lemma-module:".length) }));
    },
  };
  const staging = join(cache, `${key}.${process.pid}.tmp`);
  await rm(staging, { recursive: true, force: true });
  const result = await build({
    entryPoints: modules.map(({ file, out }) => ({ in: `lemma-entry:${file}`, out })),
    outdir: staging,
    absWorkingDir: HOST,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunks/[name]-[hash]",
    // Readable stacks and the names classes and functions were given: unminified, and none renamed.
    keepNames: true,
    // Each module runs all it would have (and one imported for a start's chunk is kept): none is left out for being
    // declared free of side effects.
    ignoreAnnotations: true,
    sourcemap: "linked",
    sourcesContent: false,
    metafile: true,
    logLevel: "warning",
    plugins: [entryPoints, nodeResolution(false)],
  });
  const built = new Map<string, string>();
  for (const [output, { entryPoint }] of Object.entries(result.metafile.outputs)) {
    if (entryPoint?.startsWith("lemma-entry:"))
      built.set(entryPoint.slice("lemma-entry:".length), relative(staging, resolve(HOST, output)).split(sep).join("/"));
  }
  const held: Manifest["packages"] = Object.fromEntries(
    [...entries].map(([dir, named]) => [dir, Object.fromEntries([...named.keys()].map((path) => [path, `${key}/${built.get(join(dir, path))!}`]))]),
  );
  await writeFile(join(staging, "modules.json"), `${JSON.stringify(held)}\n`);
  await rename(staging, join(cache, key)).catch(async (error: unknown) => {
    // Another build of the same inputs named its own first, which is the same.
    if (!existsSync(join(cache, key))) throw error;
    await rm(staging, { recursive: true, force: true });
  });
  console.log(
    `bundle-effect: ${modules.length} modules of ${packages.map(({ name, version }) => `${name}@${version}`).join(", ")}, ${loaded.length} of them a start's, into ${relative(process.cwd(), join(cache, key))}`,
  );
}
if (!fresh) {
  const manifest: Manifest = { dir: key, effect, inputs, packages: JSON.parse(readFileSync(join(cache, key, "modules.json"), "utf8")) };
  // The manifest last, so that one a host reads names a build that is all there.
  await writeFile(`${manifestPath}.${process.pid}.tmp`, `${JSON.stringify(manifest)}\n`);
  await rename(`${manifestPath}.${process.pid}.tmp`, manifestPath);
}

// Older builds, but the newest few: a host started from one loads what it imports later from it.
const builds = await readdir(cache, { withFileTypes: true }).then((found) => found.filter((entry) => entry.isDirectory() && entry.name !== key));
const byAge = await Promise.all(builds.map(async (entry) => ({ path: join(cache, entry.name), at: (await stat(join(cache, entry.name))).mtimeMs })));
for (const { path } of byAge.sort((a, b) => b.at - a.at).slice(KEPT)) await rm(path, { recursive: true, force: true });
