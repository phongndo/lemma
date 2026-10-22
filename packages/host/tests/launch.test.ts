import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HOST_FLAGS, missingHostFlags } from "../src/launch.mjs";

const run = promisify(execFile);
const host = fileURLToPath(new URL("..", import.meta.url));
const launch = new URL("../src/launch.mjs", import.meta.url).href;
const lockfile = fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url));

const made: string[] = [];
const scratch = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
/** A bundle built for these tests, as `pnpm build` builds the host's. */
let cache: string;
beforeAll(async () => {
  cache = await scratch("lemma-effect-bundle-");
  await run(process.execPath, ["--conditions=lemma-source", join(host, "scripts/bundle-effect.ts"), cache], { cwd: host, timeout: 60_000 });
}, 90_000);
afterAll(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));

/** Runs `script` in a Node.js process of its own, from the host's directory as the host runs; what it printed last, as JSON. */
const inNode = async (script: string): Promise<unknown> => {
  const { stdout } = await run(process.execPath, ["--conditions=lemma-source", "--input-type=module", "--eval", script], { cwd: host, timeout: 60_000 });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
};

interface Manifest {
  readonly packages: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly inputs: Readonly<Record<string, readonly [number, number]>>;
  readonly effect: string;
}
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "effect.json"), "utf8")) as Manifest;
const packageOf = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; exports: unknown };

/** Every file of a package, relative to it, but its dependencies'. */
const filesOf = (dir: string, under = ""): string[] =>
  readdirSync(join(dir, under), { withFileTypes: true }).flatMap((entry) => {
    const path = under === "" ? entry.name : `${under}/${entry.name}`;
    return entry.isDirectory() ? (entry.name === "node_modules" ? [] : filesOf(dir, path)) : [`./${path}`];
  });

/** What a package's `exports` names: each key, each pattern over the files its target matches (Node says which resolve). */
const exported = (dir: string): string[] => {
  const { name, exports } = packageOf(dir);
  const specifiers = new Set<string>();
  for (const [key, target] of Object.entries(exports as Record<string, unknown>)) {
    if (!key.includes("*")) specifiers.add(key);
    else if (typeof target === "string") {
      const [before, after] = target.split("*") as [string, string];
      for (const file of filesOf(dir))
        if (file.startsWith(before) && file.endsWith(after) && file.length >= before.length + after.length)
          specifiers.add(key.replace("*", file.slice(before.length, file.length - after.length)));
    }
  }
  return [...specifiers].map((key) => (key === "." ? name : `${name}${key.slice(1)}`));
};

describe("Effect's bundle", () => {
  test("holds effect and every @effect package in the lockfile; every module they export resolves into it, from anywhere", async () => {
    const { packages } = manifestOf(cache);
    const locked = new Set([...readFileSync(lockfile, "utf8").matchAll(/^ {2}'?((?:@effect\/[\w-]+)|effect)@(\d[^(':]*)/gm)].map((m) => `${m[1]}@${m[2]}`));
    expect(new Set(Object.keys(packages).map((dir) => `${packageOf(dir).name}@${packageOf(dir).version}`))).toEqual(locked);

    // A folder outside the checkout that has the packages, as a plugin's does once linked (`linkHostPackages`).
    const elsewhere = await scratch("lemma-effect-importer-");
    for (const dir of Object.keys(packages)) {
      const link = join(elsewhere, "node_modules", packageOf(dir).name);
      await mkdir(join(link, ".."), { recursive: true });
      await symlink(dir, link);
    }
    await writeFile(join(elsewhere, "resolve.mjs"), "export default (specifier) => import.meta.resolve(specifier);\n");
    const specifiers = Object.keys(packages).flatMap(exported);
    const resolved = (await inNode(`
      const { useEffectBundle } = await import(${JSON.stringify(launch)});
      const used = useEffectBundle(${JSON.stringify(cache)});
      const { default: resolve } = await import(${JSON.stringify(pathToFileURL(join(elsewhere, "resolve.mjs")).href)});
      const urls = {};
      for (const specifier of ${JSON.stringify(specifiers)}) {
        try { urls[specifier] = resolve(specifier); } catch {}
      }
      console.log(JSON.stringify({ used, urls }));
    `)) as { used: boolean; urls: Record<string, string> };
    expect(resolved.used).toBe(true);
    const modules = Object.entries(resolved.urls).filter(([, url]) => !url.endsWith(".json"));
    // Not one resolves outside it (the blocked ones, `effect/internal/*` among them, resolve nowhere).
    expect(modules.filter(([, url]) => !url.startsWith(pathToFileURL(cache).href))).toEqual([]);
    expect(new Set(modules.map(([, url]) => url)).size).toBe(Object.values(packages).reduce((sum, inPackage) => sum + Object.keys(inPackage).length, 0));
  }, 60_000);

  test("a plugin file's Effect is the host's, through linked packages or the host's own", async () => {
    const home = await scratch("lemma-effect-plugin-");
    await mkdir(join(home, "node_modules"));
    await symlink(await realpath(join(host, "node_modules/effect")), join(home, "node_modules/effect"));
    const plugin = `import { Effect } from "effect";\nimport * as Direct from "effect/Effect";\nexport default { id: "probe", layer: () => undefined, Effect, Direct };\n`;
    await mkdir(join(home, "plugins"));
    await writeFile(join(home, "plugins/linked.mjs"), plugin);
    // Outside any folder with node_modules: it resolves `effect` through the host's (`loadLocalPlugins`).
    const project = await scratch("lemma-effect-project-");
    await writeFile(join(project, "fallback.mjs"), plugin);
    const same = await inNode(`
      const { useEffectBundle } = await import(${JSON.stringify(launch)});
      const used = useEffectBundle(${JSON.stringify(cache)});
      const { Effect } = await import("effect");
      const Direct = await import("effect/Effect");
      const { loadLocalPlugins } = await import(${JSON.stringify(pathToFileURL(join(host, "src/local.ts")).href)});
      const { plugins } = await Effect.runPromise(loadLocalPlugins([${JSON.stringify(join(home, "plugins"))}, ${JSON.stringify(project)}], { bundled: {} }));
      const same = plugins.map(({ plugin }) => plugin.Effect === Effect && plugin.Direct === Direct && plugin.Direct.succeed === Effect.succeed);
      console.log(JSON.stringify({ used, same, count: plugins.length }));
    `);
    expect(same).toEqual({ used: true, same: [true, true], count: 2 });
  }, 60_000);

  test("is not used when missing, built from other packages, or built by another script: Effect loads from its modules", async () => {
    const manifest = manifestOf(cache);
    const [input, [size, mtimeMs]] = Object.entries(manifest.inputs)[0]!;
    const caches = {
      missing: await scratch("lemma-effect-missing-"),
      touched: await scratch("lemma-effect-touched-"),
      elsewhere: await scratch("lemma-effect-elsewhere-"),
    };
    await writeFile(join(caches.touched, "effect.json"), JSON.stringify({ ...manifest, inputs: { ...manifest.inputs, [input]: [size, mtimeMs + 1] } }));
    await writeFile(join(caches.elsewhere, "effect.json"), JSON.stringify({ ...manifest, effect: join(manifest.effect, "..", "other") }));
    const outcome = await inNode(`
      const { useEffectBundle } = await import(${JSON.stringify(launch)});
      const used = Object.fromEntries(Object.entries(${JSON.stringify(caches)}).map(([name, cache]) => [name, useEffectBundle(cache)]));
      const { Effect } = await import("effect");
      console.log(JSON.stringify({ used, resolved: import.meta.resolve("effect/Effect"), runs: await Effect.runPromise(Effect.succeed(1)) }));
    `);
    expect(outcome).toEqual({
      used: { missing: false, touched: false, elsewhere: false },
      resolved: pathToFileURL(join(manifest.effect, "dist/Effect.js")).href,
      runs: 1,
    });
  }, 60_000);
});

describe("the host's Node.js flags", () => {
  test("are missing unless given, by any spelling or value", () => {
    expect(missingHostFlags([])).toEqual(HOST_FLAGS);
    expect(missingHostFlags(["--conditions=lemma-source", ...HOST_FLAGS])).toEqual([]);
    expect(missingHostFlags(["--max_semi_space_size=64"])).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a process started without them starts again with them: the same process, its arguments kept", () => {
    const ran = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { relaunchWithHostFlags } = await import(${JSON.stringify(launch)}); relaunchWithHostFlags(); console.log(JSON.stringify({ pid: process.pid, execArgv: process.execArgv, argv: process.argv.slice(1) }));`,
        "kept",
      ],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(ran.status, ran.stderr).toBe(0);
    const after = JSON.parse(ran.stdout.trim()) as { pid: number; execArgv: string[]; argv: string[] };
    expect(after.pid).toBe(ran.pid);
    expect(after.execArgv).toEqual(expect.arrayContaining([...HOST_FLAGS]));
    expect(after.argv).toEqual(["kept"]);
  });
});

describe("the other kind's home", () => {
  test("a checkout's host refuses an installed Lemma's home before it writes anything there", async () => {
    const user = await scratch("lemma-other-home-");
    const env = { PATH: process.env.PATH, HOME: user, LEMMA_HOME: join(user, ".lemma") };
    const start = join(host, "src/start.mjs");
    const refused = spawnSync(process.execPath, ["--conditions=lemma-source", start, "--no-open"], { cwd: host, env, encoding: "utf8", timeout: 30_000 });
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain(`${join(user, ".lemma")} is an installed Lemma's home; a checkout keeps to its own, ${join(user, ".lemma-dev")}.`);
    expect(existsSync(join(user, ".lemma"))).toBe(false);
  });
});
