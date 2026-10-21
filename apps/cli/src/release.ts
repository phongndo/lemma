import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * What this `lemma` is, and which release is newest: what `lemma version` shows, and what `lemma update` and
 * `lemma service install` act on (docs/versioning.md). A release's archive says what built it (`release.json`, from
 * scripts/dist.ts), and the installer what installed it (`install.json`, from scripts/install.sh); a checkout says
 * neither.
 */

export const CHANNELS = ["stable", "nightly"] as const;
export type Channel = (typeof CHANNELS)[number];

export const isChannel = (value: unknown): value is Channel => typeof value === "string" && (CHANNELS as readonly string[]).includes(value);

export interface Build {
  /** What `lemma --version` prints. */
  readonly version: string;
  /** `release`: an archive of a release; `checkout`: a clone of the repository, as developers run Lemma. */
  readonly kind: "release" | "checkout";
  /** Where its files are: the release's directory, or the checkout. */
  readonly root: string;
  /** The commit it was built from; a checkout's, when git says. */
  readonly commit?: string;
  /** When the release was built, in ISO 8601. */
  readonly built?: string;
  /** What the installer recorded: the channel `lemma update` follows, the `lemma` it links, and where it keeps releases. */
  readonly channel?: Channel;
  readonly link?: string;
  readonly dataDir?: string;
  /** The Node.js it runs on. */
  readonly node: string;
}

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
      channel: isChannel(channel) ? channel : undefined,
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

const parts = (version: string): readonly number[] => version.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10) || 0);

/** Below zero when `a` is the older release, above when the newer, zero when the same. */
export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

export const isReleaseVersion = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);
