import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveName, nodeVersion, releaseTag, targets } from "./dist-config.ts";
import type { Target } from "./dist-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = `${process.platform}-${process.arch}`;
if (!(target in targets)) throw new Error(`Unsupported release platform: ${target}`);
const asset = archiveName(target as Target);
const output = resolve(root, "dist");
const temporary = await mkdtemp(join(tmpdir(), "lemma-dist-"));
const packageName = asset.replace(/\.tar\.gz$/, "");
const stage = join(temporary, packageName);

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env: { ...process.env, CI: "true" } });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return result.stdout;
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function copy(path: string): Promise<void> {
  await mkdir(dirname(join(stage, path)), { recursive: true });
  await cp(join(root, path), join(stage, path), { recursive: true });
}

// A release must resolve entirely inside its archive, never into a checkout or pnpm's store.
async function checkLinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!(await realpath(path)).startsWith(`${await realpath(stage)}${sep}`)) throw new Error(`External release symlink: ${path}`);
    } else if (entry.isDirectory()) await checkLinks(path);
  }
}

try {
  run("pnpm", ["--filter", "@lemma/web", "build"], root);
  await mkdir(stage);
  // Keep every manifest so frozen-lockfile validation covers the same workspace.
  // Only the CLI's production dependency graph gets sources and installed packages.
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "README.md", "docs"]) await copy(file);
  const packages = new Map<string, { path: string; manifest: Manifest }>();
  for (const group of ["apps", "packages", "plugins", "examples"]) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(group, entry.name);
      const manifest = JSON.parse(await readFile(join(root, path, "package.json"), "utf8")) as Manifest;
      packages.set(manifest.name, { path, manifest });
      await copy(join(path, "package.json"));
    }
  }
  const selected = new Set<string>();
  async function select(name: string): Promise<void> {
    if (selected.has(name)) return;
    selected.add(name);
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`Missing workspace package: ${name}`);
    await copy(join(pkg.path, "src"));
    for (const [dependency, specifier] of Object.entries({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies })) {
      if (specifier.startsWith("workspace:")) await select(dependency);
    }
  }
  await select("@lemma/cli");
  await copy("apps/web/dist");
  run("pnpm", ["--filter-prod", "@lemma/cli...", "install", "--prod", "--frozen-lockfile", "--ignore-scripts"], stage);

  const nodeArchive = `node-v${nodeVersion}-${target}.tar.gz`;
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== targets[target as Target]) throw new Error("Node archive checksum mismatch");
  await writeFile(join(temporary, nodeArchive), bytes);
  run("tar", ["-xzf", join(temporary, nodeArchive), "-C", temporary], root);
  await mkdir(join(stage, "runtime/bin"), { recursive: true });
  const nodeRoot = join(temporary, nodeArchive.replace(/\.tar\.gz$/, ""));
  await copyFile(join(nodeRoot, "bin/node"), join(stage, "runtime/bin/node"));
  await chmod(join(stage, "runtime/bin/node"), 0o755);
  await copyFile(join(nodeRoot, "LICENSE"), join(stage, "runtime/LICENSE"));
  await mkdir(join(stage, "bin"));
  await copyFile(join(root, "scripts/lemma.sh"), join(stage, "bin/lemma"));
  await chmod(join(stage, "bin/lemma"), 0o755);
  await writeFile(join(stage, "VERSION"), `${releaseTag}\n`);
  await checkLinks(stage);

  await mkdir(output, { recursive: true });
  run("tar", ["-czf", join(output, asset), "-C", temporary, packageName], root);
  const checksum = createHash("sha256")
    .update(await readFile(join(output, asset)))
    .digest("hex");
  await writeFile(join(output, `${asset}.sha256`), `${checksum}  ${asset}\n`);
  console.log(`Built ${join(output, asset)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
