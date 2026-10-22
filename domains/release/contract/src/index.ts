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

/**
 * How a release was installed, which says how it updates: `script`, the installer (`curl … | sh`); `homebrew`, the
 * tap's formula; `homebrew-cask`, the tap's cask (the desktop app, with its `lemma`); `mise`, mise's GitHub backend;
 * `npm`, the `lemma-harness` package; `nix`, the flake's package; `desktop`, the desktop app from its file.
 */
export const INSTALLERS = ["script", "homebrew", "homebrew-cask", "mise", "npm", "nix", "desktop"] as const;
export const Installer = Schema.Literals(INSTALLERS);
export type Installer = typeof Installer.Type;

/**
 * The installers whose releases `lemma update` (and so `release.update`) replaces, by running them: Nix's is the
 * user's configuration's to change, and the desktop app from its file is downloaded again.
 */
export const UPDATABLE: ReadonlySet<Installer> = new Set<Installer>(["script", "homebrew", "homebrew-cask", "mise", "npm"]);

/** What each installer is called in a sentence: "installed with Homebrew". */
export const INSTALLER_TITLES: Readonly<Record<Installer, string>> = {
  script: "the installer",
  homebrew: "Homebrew",
  "homebrew-cask": "Homebrew's cask",
  mise: "mise",
  npm: "npm",
  nix: "Nix",
  desktop: "the desktop app's download",
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
  /** How it was installed (`Installer`); absent for a checkout, or a release unpacked by hand. */
  installer: Schema.optional(Installer),
  /**
   * How it updates as a person would update it: `lemma update`, the package manager's command, or where to download
   * the next release. Absent when nothing installed it.
   */
  update: Schema.optional(Schema.String),
  /**
   * The channel updates come from: what the installer recorded (none for a release installed by version, which is
   * pinned); a package manager's is stable. The `lemma` command the installer or package manager puts on PATH, which
   * runs the release it installed last, and where the installer keeps releases.
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
  /**
   * Whether `release.update` can replace it: a release the installer installed, or a package manager `lemma update`
   * runs (Homebrew, mise, npm); not a checkout, Nix's, or the desktop app from its file, which `build.update` says how
   * to update.
   */
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
  /**
   * True when the update replaced the desktop app this host runs in (Homebrew's cask): it runs `version` once the app
   * is reopened, which the page offers (`lemmaDesktop.relaunch`).
   */
  reopen: Schema.optional(Schema.Boolean),
});
export type UpdateResult = typeof UpdateResult.Type;

/**
 * Why a release channel's call failed: `Checkout` (a checkout updates with git), `NotInstalled` (a release `lemma
 * update` cannot replace: Nix's, the desktop app from its file, or one unpacked by hand; its message says how it
 * updates), `Busy` (an update is under way), `Failed` (what `lemma` said).
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
