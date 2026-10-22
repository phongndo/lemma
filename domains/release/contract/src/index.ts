import { Data, Schema } from "effect";
import { defineChannel, optionalPayload } from "@lemma/contracts";

/*
 * The release domain's contract: what this Lemma is, whether a newer release is out on its channel, and installing
 * it (docs/versioning.md), as channels a client calls: the web app's About page, a script, or `lemma channels`.
 */

export { RELEASE_CONTRACT } from "./version.ts";

/** The channels an install may follow: stable, the release marked latest, which only a promotion moves; nightly, the newest. */
export const CHANNELS = ["stable", "nightly"] as const;
export const Channel = Schema.Literals(CHANNELS);
export type Channel = typeof Channel.Type;

const parts = (version: string): readonly number[] => version.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10) || 0);

/** Below zero when release `a` is older than `b`, above when newer, zero when the same: by number, not as text. */
export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** What `lemma version --json` says of a Lemma: its release, or a checkout. */
export const Build = Schema.Struct({
  /** What `lemma --version` prints. */
  version: Schema.String,
  /** `release`: an archive of a release; `checkout`: a clone of the repository, as developers run Lemma. */
  kind: Schema.Literals(["release", "checkout"]),
  /** Where its files are: the release's directory, or the checkout. */
  root: Schema.String,
  /** The commit it was built from; a checkout's, when git says. */
  commit: Schema.optional(Schema.String),
  /** When the release was built, in ISO 8601. */
  built: Schema.optional(Schema.String),
  /**
   * What the installer recorded: the channel updates come from (none for a release installed by version, which is
   * pinned), the `lemma` command it links, and where it keeps releases.
   */
  channel: Schema.optional(Channel),
  link: Schema.optional(Schema.String),
  dataDir: Schema.optional(Schema.String),
  /** The Node.js it runs on. */
  node: Schema.String,
});
export type Build = typeof Build.Type;

/** This Lemma, and what the last check for a newer release found. */
export const ReleaseStatus = Schema.Struct({
  build: Build,
  /** Whether `release.update` can replace it: a release the installer installed, not a checkout. */
  updatable: Schema.Boolean,
  /**
   * The channel updates come from: what the installer recorded with the release installed last, which `lemma update
   * --channel` may have switched since this host started. None for a pinned release, which checks for nothing.
   */
  channel: Schema.optional(Channel),
  /** The channel's newest release, as the last check found it, and whether it is newer than this. */
  newest: Schema.optional(Schema.String),
  newer: Schema.Boolean,
  /** Why the last check failed, if it did. */
  error: Schema.optional(Schema.String),
  /** Why the restart `release.update` asked for failed, leaving this host running; absent when none did. */
  restartError: Schema.optional(Schema.String),
});
export type ReleaseStatus = typeof ReleaseStatus.Type;

/** What `release.update` did: the release now installed, and whether the host is restarting on it. */
export const UpdateResult = Schema.Struct({
  version: Schema.String,
  /** False when the release asked for was installed already. */
  updated: Schema.Boolean,
  /** True when the host stops after answering and starts again on `version`: the page should reload once it is back. */
  restarting: Schema.Boolean,
});
export type UpdateResult = typeof UpdateResult.Type;

/**
 * Why a release channel's call failed: `Checkout` (a checkout updates with git), `NotInstalled` (a release the
 * installer did not install), `Busy` (an update is under way), `Failed` (what `lemma` said).
 */
export class ReleaseError extends Data.TaggedError("ReleaseError")<{
  readonly reason: "Checkout" | "NotInstalled" | "Busy" | "Failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const ReleaseChannels = {
  /** This Lemma, and what the last check found; it asks nothing of the network. */
  status: defineChannel({
    kind: "call",
    id: "release.status",
    access: "read",
    title: "Release",
    description: "This Lemma: its version, the commit it was built from, its channel, where it is installed, and whether a newer release is out",
    payload: Schema.Void,
    success: ReleaseStatus,
    repeatable: true,
  }),
  /** Asks now whether a newer release is out on the channel. */
  check: defineChannel({
    kind: "call",
    id: "release.check",
    access: "read",
    title: "Check for updates",
    description: "Ask now whether a newer release is out on this Lemma's channel",
    payload: Schema.Void,
    success: ReleaseStatus,
    repeatable: true,
  }),
  /**
   * Installs the channel's newest release when it is newer, or `version`, as `lemma update` does, then restarts the
   * host on it, as `lemma restart --force` does, once it has answered: what was running is cut off, and turns resume.
   * One update at a time: another, until the restart has stopped the host or failed, is `Busy`.
   */
  update: defineChannel({
    kind: "call",
    id: "release.update",
    access: "change",
    title: "Update Lemma",
    description: "Install the channel's newest release, or the version given, and restart the host on it",
    payload: optionalPayload({ version: Schema.optional(Schema.String) }),
    success: UpdateResult,
  }),
} as const;
