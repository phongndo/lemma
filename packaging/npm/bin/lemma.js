#!/usr/bin/env node
/*
 * The `lemma` command of npm's `lemma-harness` (packaging/npm/README.md). It runs the Lemma release of its package's
 * version, which it fetches from GitHub the first time it runs, checked against its SHA-256, into a directory of its
 * own outside node_modules: Lemma runs its TypeScript sources, which Node.js strips of their types only outside
 * node_modules. The release runs on the Node.js it carries, whatever runs this.
 *
 * `current` links the release this package's version is, which `lemma update` and a service run (`install.json`);
 * the release before it is kept, and any a running host still uses, by its command line.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const self = realpathSync(fileURLToPath(import.meta.url));
const { name: packageName, version } = JSON.parse(readFileSync(join(dirname(self), "..", "package.json"), "utf8"));

const fail = (message) => {
  process.stderr.write(`lemma-harness: ${message}\n`);
  process.exit(1);
};

const os = { darwin: "darwin", linux: "linux" }[process.platform];
const cpu = { arm64: "arm64", x64: "x64" }[process.arch];
if (os === undefined || cpu === undefined || `${os}-${cpu}` === "darwin-x64")
  fail(`Lemma runs on macOS on Apple silicon, and on Linux on arm64 and x64: not ${process.platform}-${process.arch}`);
const name = `lemma-v${version}-${os}-${cpu}`;
const data = process.env.LEMMA_NPM_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "lemma", "npm");
const root = join(data, name);
const current = join(data, "current");

/** The package manager that installed this, by where it lies, and how it installs a version: what `lemma update` runs. */
const manager = () => {
  if (self.includes("/pnpm/")) return { command: "pnpm", install: ["add", "--global"] };
  if (self.includes("/.bun/")) return { command: "bun", install: ["add", "--global"] };
  // npm beside the Node.js running this (the official installer's, nvm's, Homebrew's), else the one on PATH.
  const beside = join(dirname(process.execPath), "npm");
  return { command: existsSync(beside) ? beside : "npm", install: ["install", "--global"] };
};

/** Fetches the release into `root`: downloaded, checked, unpacked beside it, run once, then moved into place. */
const fetchRelease = async () => {
  const base = process.env.LEMMA_RELEASE_BASE_URL || `https://github.com/phongndo/lemma/releases/download/v${version}`;
  const file = `${name}.tar.gz`;
  process.stderr.write(`lemma-harness: fetching Lemma ${version} for ${os}-${cpu}\n`);
  const download = async (path) => {
    const response = await fetch(`${base}/${path}`).catch((error) => fail(`could not download ${path}: ${error.message}`));
    if (!response.ok) fail(`could not download ${path}: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const archive = await download(file);
  const sums = (await download(`${file}.sha256`)).toString("utf8");
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, named]) => named === file)?.[0];
  if (expected === undefined || createHash("sha256").update(archive).digest("hex") !== expected) fail(`${file} does not match its checksum`);
  mkdirSync(data, { recursive: true });
  const staging = mkdtempSync(join(data, `.${name}.`));
  try {
    writeFileSync(join(staging, file), archive);
    if (spawnSync("tar", ["-xzf", file], { cwd: staging, stdio: ["ignore", "ignore", "inherit"] }).status !== 0) fail(`could not unpack ${file}`);
    const unpacked = join(staging, name);
    if (!existsSync(join(unpacked, "bin", "lemma")) || !existsSync(join(unpacked, "runtime", "bin", "node"))) fail(`${file} holds no Lemma and runtime`);
    const { command, install } = manager();
    // What installed it, which `lemma version` shows and `lemma update` updates it by.
    const recorded = {
      installer: "npm",
      link: join(current, "bin", "lemma"),
      manager: command,
      install,
      launcher: self,
      node: process.execPath,
      package: packageName,
    };
    writeFileSync(join(unpacked, "install.json"), `${JSON.stringify(recorded, null, 2)}\n`);
    if (spawnSync(join(unpacked, "bin", "lemma"), ["--version", "--text"], { stdio: "ignore" }).status !== 0)
      fail(
        existsSync("/etc/NIXOS")
          ? `this machine cannot run ${name}: on NixOS, its Node.js needs nix-ld (programs.nix-ld.enable)`
          : `this machine cannot run ${name}`,
      );
    try {
      renameSync(unpacked, root);
    } catch (error) {
      // Another `lemma` fetched it first.
      if (!existsSync(join(root, "release.json"))) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

/** Links `current` to this release, by a rename, so it never names none; then removes the releases neither it, the one before, nor a running process uses. */
const switchCurrent = () => {
  let previous;
  try {
    previous = readlinkSync(current);
  } catch {
    // None yet.
  }
  if (previous === name) return;
  const next = `${current}.${process.pid}`;
  symlinkSync(name, next);
  renameSync(next, current);
  let running;
  try {
    running = execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of readdirSync(data)) {
    if (!entry.startsWith("lemma-v") || entry === name || entry === previous) continue;
    const release = join(data, entry);
    if (!running.includes(`${release}/`)) rmSync(release, { recursive: true, force: true });
  }
};

if (!existsSync(join(root, "release.json"))) await fetchRelease();
switchCurrent();

// The terminal's interrupt reaches the release's process too; a signal sent to this one alone is passed on.
const child = spawn(join(root, "bin", "lemma"), process.argv.slice(2), { stdio: "inherit" });
process.on("SIGINT", () => {});
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => fail(`could not run ${name}: ${error.message}`));
child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
