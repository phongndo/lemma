import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };

const launcher = fileURLToPath(new URL("../bin/lemma.js", import.meta.url));
const buildScript = fileURLToPath(new URL("../scripts/build.ts", import.meta.url));

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "lemma-launch-"));
  made.push(dir);
  return dir;
};

/** A package laid out as this one is, the launcher in it, whose two entries say which of them ran. */
const layout = async () => {
  const root = await scratch();
  for (const dir of ["bin", "src", "dist"]) await mkdir(join(root, dir));
  await copyFile(launcher, join(root, "bin/lemma.js"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "src/main.ts"), 'console.log(`sources ${process.argv.slice(2).join(" ")}`);\n');
  await writeFile(join(root, "src/input.ts"), "export const input = 1;\n");
  await writeFile(join(root, "dist/lemma.mjs"), 'console.log(`bundle ${process.argv.slice(2).join(" ")}`);\n');
  const { size, mtimeMs } = await stat(join(root, "src/input.ts"));
  await writeFile(join(root, "dist/lemma.json"), JSON.stringify({ files: { "../src/input.ts": [size, mtimeMs] } }));
  return root;
};

const launch = (root: string, ...args: string[]) => {
  const ran = spawnSync(process.execPath, [join(root, "bin/lemma.js"), ...args], { encoding: "utf8" });
  expect(ran.status, ran.stderr).toBe(0);
  return ran.stdout.trim();
};

describe("bin/lemma.js", () => {
  test("runs the bundle while the files it was built from are unchanged", async () => {
    const root = await layout();
    expect(launch(root, "status")).toBe("bundle status");
  });

  test("runs the sources once a file the bundle was built from changed", async () => {
    const root = await layout();
    await writeFile(join(root, "src/input.ts"), "export const input = 12;\n");
    expect(launch(root, "status")).toBe("sources status");
  });

  test("runs the sources once a file it was built from is touched (the same size, written since) or gone", async () => {
    const root = await layout();
    await utimes(join(root, "src/input.ts"), new Date(), new Date(Date.now() + 60_000));
    expect(launch(root, "status")).toBe("sources status");
    await rm(join(root, "src/input.ts"));
    expect(launch(root, "status")).toBe("sources status");
  });

  test("runs the sources with no list of what the bundle was built from, or one it cannot read", async () => {
    const root = await layout();
    await writeFile(join(root, "dist/lemma.json"), "{");
    expect(launch(root, "status")).toBe("sources status");
    await rm(join(root, "dist/lemma.json"));
    expect(launch(root, "status")).toBe("sources status");
  });

  test("runs a host from the sources, which it shares", async () => {
    const root = await layout();
    expect(launch(root, "serve", "--no-open")).toBe("sources serve --no-open");
  });
});

describe("scripts/build.ts", () => {
  test("bundles the command, listing the workspace's sources it read, their manifests, and the lockfile; the bundle finds the checkout's files as the sources do", async () => {
    // Laid out as the checkout is, so what the bundle finds beside it (the built web app) is where the sources find it.
    const root = await scratch();
    const dist = join(root, "apps/cli/dist");
    const built = spawnSync(process.execPath, [buildScript, dist], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);

    const { files } = JSON.parse(await readFile(join(dist, "lemma.json"), "utf8")) as { files: Record<string, [number, number]> };
    const listed = Object.keys(files).map((path) => resolve(dist, path));
    const here = fileURLToPath(new URL("..", import.meta.url));
    const workspace = resolve(here, "../..");
    for (const file of ["apps/cli/src/cli.ts", "apps/cli/package.json", "packages/client/src/host.ts", "packages/client/package.json", "pnpm-lock.yaml"])
      expect(listed).toContain(join(workspace, file));
    expect(listed.some((path) => path.includes("node_modules"))).toBe(false);
    for (const [path, [size, mtimeMs]] of Object.entries(files)) expect(await stat(resolve(dist, path))).toMatchObject({ size, mtimeMs });

    const home = await scratch();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(dist, "lemma.mjs"), ...args], { encoding: "utf8", env: { ...process.env, LEMMA_HOME: home } });
    expect(JSON.parse(run("--version", "--json").stdout)).toEqual({ version: packageJson.version });
    const web = () => (JSON.parse(run("doctor", "--json").stdout) as { id: string; status: string }[]).find((check) => check.id === "web")?.status;
    expect(web()).toBe("warn");
    await mkdir(join(root, "apps/web/dist"), { recursive: true });
    await writeFile(join(root, "apps/web/dist/index.html"), "<!doctype html>");
    expect(web()).toBe("ok");
  });
});
