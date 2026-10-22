import { readFileSync } from "node:fs";

/*
 * What a release is: its version, the platforms it is built for, and the
 * Node.js runtime each archive carries. `dist.ts` builds the archives,
 * `dist-check.ts` installs and runs one, and the nightly workflow publishes
 * them (docs/development.md#releases).
 */

/**
 * The checkout's version, which `lemma --version` prints run from it. Its major and minor are the line releases are
 * numbered in: each nightly takes the next patch in it, and `dist.ts` writes that version into the archive.
 */
export const version = (JSON.parse(readFileSync(new URL("../apps/cli/package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * The platforms a release is for, each with the official Node.js archive its
 * runtime comes from, pinned by SHA-256. Update the version and the hashes
 * together, from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
 */
export const nodeVersion = "24.22.0";
export const targets = {
  "darwin-arm64": "6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5",
  "linux-arm64": "b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d",
  "linux-x64": "28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c",
} as const;
export type Target = keyof typeof targets;

export const isTarget = (target: string): target is Target => Object.hasOwn(targets, target);

/** This machine's target, which `pnpm dist` builds unless told another, and the only one `dist-check.ts` can run. */
export const hostTarget = (): Target => {
  const target = `${process.platform}-${process.arch}`;
  if (!isTarget(target)) throw new Error(`Lemma has no release for ${target}: it is built for ${Object.keys(targets).join(", ")}`);
  return target;
};

/** `lemma-v0.2.7-darwin-arm64`: the archive's top directory, and with `.tar.gz` its file name. */
export const packageName = (release: string, target: Target): string => `lemma-v${release}-${target}`;

/** `lemma-desktop-v0.2.7-darwin-arm64`: the desktop app's file name, before its format's extension (dist-desktop.ts). */
export const desktopPackageName = (release: string, target: Target): string => `lemma-desktop-v${release}-${target}`;

/** The version and target a desktop app's file name says it holds, and its format. */
export const parseDesktopPackageName = (file: string): { readonly version: string; readonly target: Target; readonly format: string } | undefined => {
  const match = /^lemma-desktop-v(\d+\.\d+\.\d+)-([a-z0-9-]+)\.(dmg|AppImage|deb)$/.exec(file);
  return match && isTarget(match[2]!) ? { version: match[1]!, target: match[2], format: match[3]! } : undefined;
};

/** The version and target an archive's file name says it holds. */
export const parsePackageName = (file: string): { readonly version: string; readonly target: Target } | undefined => {
  const match = /^lemma-v(\d+\.\d+\.\d+)-([a-z0-9-]+)\.tar\.gz$/.exec(file);
  return match && isTarget(match[2]!) ? { version: match[1]!, target: match[2] } : undefined;
};
