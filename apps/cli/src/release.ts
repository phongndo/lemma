import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { Channel } from "@lemma/release";
import type { Build } from "@lemma/release";

/*
 * What this `lemma` is, and which release is newest: what `lemma version` shows, and what `lemma update` and
 * `lemma service install` act on (docs/versioning.md). A release's archive says what built it (`release.json`, from
 * scripts/dist.ts), and the installer what installed it (`install.json`, from scripts/install.sh); a checkout says
 * neither.
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

/** The `lemma` whose files are at `root`, this one's by default. A checkout's commit comes from git, which may say nothing. */
export const readBuild = (root = lemmaRoot): Build => {
  const node = process.versions.node;
  const release = readJson(join(root, "release.json"));
  const version = text(release?.version);
  if (version !== undefined) {
    const install = readJson(join(root, "install.json"));
    const channel = install?.channel;
    const fields = {
      commit: text(release?.commit),
      built: text(release?.built),
      channel: Schema.is(Channel)(channel) ? channel : undefined,
      link: text(install?.link),
      dataDir: text(install?.dataDir),
    };
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
