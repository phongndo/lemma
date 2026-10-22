import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { Channel, Installer } from "@lemma/release";

/*
 * The ways Lemma is installed, and how each updates (docs/installation.md#install-methods): which one installed a
 * release, from what it recorded (`install.json`) or where the release lies, and what `lemma update` runs for it.
 */

export const RELEASES_URL = "https://github.com/phongndo/lemma/releases";
export const INSTALL_SCRIPT = "curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh";
export const INSTALL_NIGHTLY = "curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | LEMMA_CHANNEL=nightly sh";
/** The Homebrew tap's formula and cask, both `lemma`. */
export const TAP = "phongndo/tap";
export const NPM_PACKAGE = "lemma-harness";
/** What mise installs Lemma as: its GitHub backend reads the releases directly. */
export const MISE_TOOL = "github:phongndo/lemma";
/** The directory mise installs each version of `MISE_TOOL` in, under its `installs`. */
const MISE_DIR = "github-phongndo-lemma";

/** Who installed a release, as `readBuild` reads it, with what that installer recorded. */
export interface Install {
  readonly installer?: Installer;
  /** How it updates as a person would (`Build.update`). */
  readonly update?: string;
  /** The channel it follows: what the installer recorded (none: pinned), stable for a package manager. */
  readonly channel?: Channel;
  /** The `lemma` it puts on PATH, which runs the release it installed last. */
  readonly link?: string;
  /** The installer's: where it keeps releases. */
  readonly dataDir?: string;
  /** The package manager's own command, as the installer recorded it (npm's, Homebrew's). */
  readonly manager?: string;
  /** npm's launcher: how its package manager installs a version (`install --global`), the launcher, and its Node.js. */
  readonly install?: readonly string[];
  readonly launcher?: string;
  readonly node?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Homebrew's prefix, where its `bin`, `Caskroom`, and `Cellar` are: `HOMEBREW_PREFIX`, else the one Apple silicon has. */
export const brewPrefix = (env: Readonly<Record<string, string | undefined>>): string => env.HOMEBREW_PREFIX?.trim() || "/opt/homebrew";

/** The first `name` on PATH, else the first of `fallbacks` that exists. */
export const findCommand = (name: string, env: Readonly<Record<string, string | undefined>>, fallbacks: readonly string[] = []): string | undefined => {
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
  return fallbacks.find((path) => existsSync(path));
};

const desktopUpdate = (mac: boolean) =>
  mac
    ? `download the next release's disk image from ${RELEASES_URL}, or install the app with Homebrew to update it from Lemma: brew install --cask ${TAP}/lemma`
    : `download the next release's AppImage or Debian package from ${RELEASES_URL}`;

/**
 * Who installed the release at `root`, from `install.json` (`recorded`) when its installer wrote one (the installer,
 * Homebrew's formula, npm's launcher, Nix), else from where it lies: a macOS app's resources (Homebrew's cask when its
 * Caskroom has it), a Linux app's, or mise's installs. None for a release unpacked by hand.
 */
export const installOf = (root: string, recorded: Record<string, unknown> | undefined, env: Readonly<Record<string, string | undefined>>): Install => {
  const link = text(recorded?.link);
  const manager = text(recorded?.manager);
  switch (recorded?.installer) {
    case "homebrew":
      return { installer: "homebrew", update: `brew upgrade ${TAP}/lemma`, channel: "stable", ...(link && { link }), ...(manager && { manager }) };
    case "npm": {
      // npm's, or pnpm's or bun's, as the launcher found it was installed.
      const install =
        Array.isArray(recorded.install) && recorded.install.every((arg) => typeof arg === "string") ? (recorded.install as string[]) : ["install", "--global"];
      const launcher = text(recorded.launcher);
      const node = text(recorded.node);
      return {
        installer: "npm",
        update: `${basename(manager ?? "npm")} ${install.join(" ")} ${NPM_PACKAGE}`,
        channel: "stable",
        install,
        ...(link && { link }),
        ...(manager && { manager }),
        ...(launcher && { launcher }),
        ...(node && { node }),
      };
    }
    case "nix":
      return {
        installer: "nix",
        update: "update the flake input that brings Lemma (nix flake update lemma) and rebuild, or: nix profile upgrade lemma",
        channel: "stable",
        ...(link && { link }),
      };
    default:
      break;
  }
  const dataDir = text(recorded?.dataDir);
  if (link !== undefined && dataDir !== undefined) {
    const channel = recorded?.channel === "stable" || recorded?.channel === "nightly" ? recorded.channel : undefined;
    return { installer: "script", update: "lemma update", link, dataDir, ...(channel && { channel }) };
  }
  // A desktop app: the release is its resources, at a path each update keeps.
  if (/\/Contents\/Resources\/lemma\/?$/.test(root)) {
    const prefix = brewPrefix(env);
    const own = join(root, "bin", "lemma");
    return existsSync(join(prefix, "Caskroom", "lemma"))
      ? { installer: "homebrew-cask", update: `brew upgrade --cask ${TAP}/lemma`, channel: "stable", link: own, manager: join(prefix, "bin", "brew") }
      : { installer: "desktop", update: desktopUpdate(true), channel: "stable", link: own };
  }
  if (/\/resources\/lemma\/?$/.test(root)) return { installer: "desktop", update: desktopUpdate(false), channel: "stable" };
  // mise's GitHub backend: <data>/installs/github-phongndo-lemma/<version>, with `latest` linked to the newest installed.
  const installs = /^(.*\/installs\/[^/]+)\/[^/]+\/?$/.exec(root)?.[1];
  if (installs !== undefined && basename(installs) === MISE_DIR) {
    const latest = join(installs, "latest", "bin", "lemma");
    return { installer: "mise", update: `mise upgrade ${MISE_TOOL}`, channel: "stable", ...(existsSync(latest) && { link: latest }) };
  }
  return {};
};

/** Where mise installs `version` of Lemma, beside the one at `root`. */
export const miseRoot = (root: string, version: string): string => join(dirname(root), version);
