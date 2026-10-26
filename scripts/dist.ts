import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hostTarget, isTarget, nodeVersion, packageName, targets, version } from "./dist-config.ts";
import type { Target } from "./dist-config.ts";

/*
 * Builds release archives into `dist/`: `lemma-v<version>-<target>.tar.gz` and its `.sha256` for each target, which
 * runs without a checkout, Nix, or Node.js installed (docs/installation.md):
 *
 *   bin/lemma              the command (scripts/lemma.sh), which runs the CLI on the runtime below
 *   release.json           what it is: its version, the commit it was built from, and when (`lemma version`)
 *   scripts/install.sh     the installer, which `lemma update` runs to install another release
 *   runtime/bin/node       the official Node.js build dist-config.ts pins, by version and checksum
 *   apps/, packages/, …    the workspace, laid out as in the checkout: the `lemma` command's packages and the desktop
 *                          app's (scripts/dist-desktop.ts makes the app from the archive), what they read beside their
 *                          sources (a profile's files, the app icon), the web app's build, and the docs and examples
 *   node_modules/          their production dependencies, installed from the lockfile for the target, without their
 *                          source maps and TypeScript sources (`prune`)
 *
 * The workspace keeps its layout because Lemma runs its TypeScript sources, which Node strips of their types only
 * outside `node_modules`, and because the host finds the web app and each bundled plugin by its path in it.
 *
 *   pnpm dist                                       this machine's archive, at the checkout's version
 *   pnpm dist --version 0.2.7 --target all          every target's, as the nightly workflow builds them
 *   pnpm dist --commit <sha>                        built from another commit than the checkout's (its HEAD)
 *
 * One machine builds every target's: the sources and builds are the same for each, and pnpm installs another
 * platform's prebuilt packages (fff's file search) when told the platform. Nothing compiles at install
 * (`--ignore-scripts`), so a dependency that needs to fails each platform's smoke test (dist-check.ts).
 */

const { values } = parseArgs({
  options: { version: { type: "string", default: version }, target: { type: "string", multiple: true }, commit: { type: "string" } },
});
const release = values.version;
if (!/^\d+\.\d+\.\d+$/.test(release)) throw new Error(`Not a release version: ${release}`);
const chosen: readonly Target[] =
  values.target === undefined
    ? [hostTarget()]
    : values.target.flatMap((target) => {
        if (target === "all") return Object.keys(targets) as Target[];
        if (!isTarget(target)) throw new Error(`No target ${target}: one of ${Object.keys(targets).join(", ")}, or all`);
        return [target];
      });

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist");
const temporary = await mkdtemp(join(tmpdir(), "lemma-dist-"));
const built = new Date().toISOString().replace(/\.\d+Z$/, "Z");

const env = { ...process.env, CI: "true" };
const run = (command: string, args: readonly string[], cwd = root): void => {
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env });
};
const read = (command: string, args: readonly string[]): string => execFileSync(command, args, { cwd: root, encoding: "utf8", env });
const commit = values.commit ?? read("git", ["rev-parse", "HEAD"]).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a commit: ${commit}`);

interface Project {
  readonly path: string;
}
const projects = (args: readonly string[]): Project[] => JSON.parse(read("pnpm", [...args, "ls", "--depth", "-1", "--json"])) as Project[];

/** Copies `paths` (relative to the checkout) into `stage`. */
const copy = async (stage: string, paths: readonly string[]) => {
  for (const path of paths) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(root, path), join(stage, path), { recursive: true });
  }
};

/**
 * The files under `paths` git would commit, tests left out: what a release carries of the source, not whatever else
 * lies in the checkout (builds, a home's files, an editor's).
 */
const tracked = (paths: readonly string[]): string[] =>
  read("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths])
    .split("\0")
    .filter((path) => path !== "" && !path.split("/").includes("tests") && existsSync(join(root, path)));

/** Fails on a symlink that leaves the stage: a release resolves entirely inside its archive, never into a checkout or pnpm's store. */
const checkLinks = async (stage: string, dir: string, inside: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(path).catch(() => undefined);
      if (resolved === undefined || !resolved.startsWith(inside + sep)) throw new Error(`The release links outside itself: ${relative(stage, path)}`);
    } else if (entry.isDirectory()) await checkLinks(stage, path, inside);
  }
};

/**
 * Removes what the dependencies publish for their own debugging, which nothing in a release reads: source maps, and
 * TypeScript sources (`.ts`, not `.d.ts`), which Node does not strip of their types inside `node_modules` and a package
 * names only under conditions Lemma's runtime never resolves (`source`, `types`). A third of the archive's files.
 * Declarations stay, as an editor's types for a plugin file (docs/plugins.md). Links are not followed: pnpm's lead to
 * packages in the same directory, which the walk reaches anyway.
 */
const prune = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await prune(path);
    else if (entry.isFile() && /\.map$|(?<!\.d)\.[mc]?ts$/.test(entry.name)) await rm(path);
  }
};

/** The platform pnpm installs a target's optional packages for: their `os`, `cpu`, and on Linux `libc` (glibc). */
const platformFlags = (target: Target): string[] => {
  const [os, cpu] = target.split("-") as [string, string];
  return [`--os=${os}`, `--cpu=${cpu}`, ...(os === "linux" ? ["--libc=glibc"] : [])];
};

try {
  // The libraries' declarations (an editor's types for a plugin file), and the page the host serves, with the
  // release's icon rather than a checkout's. The page builds outside the checkout, whose own build stays a checkout's.
  run("pnpm", ["build"]);
  const page = join(temporary, "page");
  run("pnpm", ["--filter", "@lemma/web-app", "build", "--mode", "release", "--outDir", page, "--emptyOutDir"]);

  // Every project's manifest, so the frozen lockfile matches the workspace; the sources of the command's and the desktop
  // app's production closures only, and the builds their packages export.
  const closures = ["--filter-prod", "@lemma/cli-app...", "--filter-prod", "@lemma/desktop..."];
  const included = projects(closures).map((project) => relative(root, project.path));
  const manifests = projects(["--recursive"]).map((project) => relative(root, join(project.path, "package.json")));
  const sources = tracked([
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "LICENSE",
    "README.md",
    "scripts/install.sh",
    "assets/brand/icon-dark.png",
    "docs",
    "examples",
    ...manifests,
    ...included,
  ]);
  const builds: string[] = [];
  for (const path of included) {
    const manifest = await readFile(join(root, path, "package.json"), "utf8");
    if (manifest.includes('"./dist/')) builds.push(join(path, "dist"));
  }
  await mkdir(output, { recursive: true });
  // The workspace once, file by file, then whole for each target: the same for every one until its install.
  const workspace = join(temporary, "workspace");
  await copy(workspace, [...sources, ...builds]);
  await cp(page, join(workspace, "apps/web/dist"), { recursive: true });

  for (const target of chosen) {
    const name = packageName(release, target);
    const stage = join(temporary, name);
    await cp(workspace, stage, { recursive: true });
    run("pnpm", [...closures, "install", "--prod", "--frozen-lockfile", "--ignore-scripts", ...platformFlags(target)], stage);
    await prune(join(stage, "node_modules/.pnpm"));

    const nodeName = `node-v${nodeVersion}-${target}`;
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.gz`);
    if (!response.ok) throw new Error(`Downloading Node.js ${nodeVersion} failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== targets[target]) throw new Error(`${nodeName}.tar.gz does not match its pinned checksum`);
    await writeFile(join(temporary, `${nodeName}.tar.gz`), archive);
    run("tar", ["-xzf", join(temporary, `${nodeName}.tar.gz`), "-C", temporary, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
    await mkdir(join(stage, "runtime/bin"), { recursive: true });
    await copyFile(join(temporary, nodeName, "bin/node"), join(stage, "runtime/bin/node"));
    await copyFile(join(temporary, nodeName, "LICENSE"), join(stage, "runtime/LICENSE"));

    await mkdir(join(stage, "bin"));
    await copyFile(join(root, "scripts/lemma.sh"), join(stage, "bin/lemma"));
    await chmod(join(stage, "bin/lemma"), 0o755);
    // The release's version, which `lemma --version` prints, in place of the checkout's.
    const cli = join(stage, "apps/cli/package.json");
    await writeFile(cli, `${JSON.stringify({ ...JSON.parse(await readFile(cli, "utf8")), version: release }, null, 2)}\n`);
    await writeFile(join(stage, "release.json"), `${JSON.stringify({ version: release, commit, built }, null, 2)}\n`);
    await checkLinks(stage, stage, await realpath(stage));

    const file = join(output, `${name}.tar.gz`);
    run("tar", ["-czf", file, "-C", temporary, name]);
    const checksum = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    await writeFile(`${file}.sha256`, `${checksum}  ${name}.tar.gz\n`);
    console.log(`Built ${relative(root, file)}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
