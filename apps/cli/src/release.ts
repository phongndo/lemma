import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Build, Channel } from "@lemma/release";
import { installOf } from "./installers.ts";
import type { Install } from "./installers.ts";

/*
 * What this `lemma` is, and which release is newest: what `lemma version` shows, and what `lemma update` and
 * `lemma service install` act on (docs/versioning.md). A release's archive says what built it (`release.json`, from
 * scripts/dist.ts), and what installed it says so (`install.json`, from scripts/install.sh, Homebrew's formula, npm's
 * launcher, or Nix), or where it lies does (installers.ts); a checkout says neither.
 */

const lemmaRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Who installed the release at `root`, with what it recorded: `readBuild`'s, and the package manager's own command. */
export const readInstall = (root: string, env: Readonly<Record<string, string | undefined>> = process.env): Install =>
  installOf(root, readJson(join(root, "install.json")), env);

/**
 * The `lemma` whose files are at `root`, this one's by default, and who installed it (`installOf`, which reads
 * `env` for Homebrew's prefix). A checkout's commit comes from git, which may say nothing.
 */
export const readBuild = (root = lemmaRoot, env: Readonly<Record<string, string | undefined>> = process.env): Build => {
  const node = process.versions.node;
  const release = readJson(join(root, "release.json"));
  const version = text(release?.version);
  if (version !== undefined) {
    const { installer, update, channel, link, dataDir } = readInstall(root, env);
    const fields = { commit: text(release?.commit), built: text(release?.built), installer, update, channel, link, dataDir };
    return { version, kind: "release", root, node, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
  }
  const git = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const commit = git.status === 0 ? git.stdout.trim() : undefined;
  return { version: text(readJson(join(root, "apps/cli/package.json"))?.version) ?? "0.0.0", kind: "checkout", root, node, ...(commit ? { commit } : {}) };
};

/** Where `lemma update` asks which release is newest: GitHub's API for the repository, or `LEMMA_RELEASE_API_URL`. */
export const releasesApi = (env: Readonly<Record<string, string | undefined>>): string =>
  (env.LEMMA_RELEASE_API_URL?.trim() || "https://api.github.com/repos/phongndo/lemma").replace(/\/+$/, "");

/**
 * The newest release on `channel`, by version: stable's is the release GitHub marks latest, which only a promotion
 * moves; nightly's is the newest published. Undefined when the channel has none yet.
 */
export const newestRelease = async (api: string, channel: Channel, signal?: AbortSignal): Promise<string | undefined> => {
  const response = await fetch(channel === "stable" ? `${api}/releases/latest` : `${api}/releases?per_page=1`, {
    headers: { accept: "application/vnd.github+json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (channel === "stable" && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${api} answered ${response.status} ${response.statusText}`);
  const body: unknown = await response.json();
  const release: unknown = Array.isArray(body) ? body[0] : body;
  const tag = typeof release === "object" && release !== null ? (release as { tag_name?: unknown }).tag_name : undefined;
  return typeof tag === "string" ? tag.replace(/^v/, "") : undefined;
};

export const isReleaseVersion = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);
