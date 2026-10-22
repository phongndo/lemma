import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "effect";
import { DEEP_LINK_SCHEME, DEV_DEEP_LINK_SCHEME } from "@lemma/contracts/addresses";
import type { Paths } from "@lemma/contracts";
import { profileHome, profileNameProblem, profileOf } from "@lemma/contracts/profiles";

// Imports only what needs no build (types, and modules of no dependencies of their own): the web app's vite.config
// reads it, before anything is built and without the `lemma-source` condition.

export type PathsService = Context.Service.Shape<typeof Paths>;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * What this Lemma runs from: `release`, a release's archive, which carries `release.json` at its root (scripts/dist.ts),
 * or `checkout`, a clone of the repository, as developers run it.
 */
export type BuildKind = "release" | "checkout";
export const buildKind: BuildKind = existsSync(fileURLToPath(new URL("../../../release.json", import.meta.url))) ? "release" : "checkout";

/**
 * Each kind's own, so an installed Lemma and a checkout run side by side, neither reaching the other's sessions and
 * settings: its root in the user's home, its default profile's port (its other profiles' from the next one up), the
 * name it is shown by, and its desktop app's link scheme.
 */
export const KINDS: Readonly<Record<BuildKind, { readonly root: string; readonly port: number; readonly name: string; readonly scheme: string }>> = {
  release: { root: ".lemma", port: 7433, name: "Lemma", scheme: DEEP_LINK_SCHEME },
  checkout: { root: ".lemma-dev", port: 7533, name: "Lemma Dev", scheme: DEV_DEEP_LINK_SCHEME },
};

/** The root a kind uses when `LEMMA_HOME` names none: `~/.lemma` for a release, `~/.lemma-dev` for a checkout. */
export const defaultRoot = (env: Env, kind: BuildKind = buildKind): string => join(env.HOME || homedir(), KINDS[kind].root);

/**
 * Why this kind keeps off `root`: it is the other's own, as a `LEMMA_HOME` inherited from the other's host or shell names
 * it, whose sessions and settings this kind's code may write in a form the other's does not read. The host does not run
 * there, nor `lemma` start, stop, or restart one; `LEMMA_ALLOW_OTHER_HOME=1` allows it.
 */
export const otherHomeProblem = (root: string, env: Env, kind: BuildKind = buildKind): string | undefined => {
  const other: BuildKind = kind === "release" ? "checkout" : "release";
  if (env.LEMMA_ALLOW_OTHER_HOME === "1" || resolve(root) !== defaultRoot(env, other)) return undefined;
  const whose = kind === "checkout" ? "an installed Lemma's home; a checkout keeps to its own" : "a checkout's home; an installed Lemma keeps to its own";
  return `${root} is ${whose}, ${defaultRoot(env, kind)}. LEMMA_HOME names it here, perhaps inherited from the other's host or your shell: unset it, or set LEMMA_ALLOW_OTHER_HOME=1 to use it anyway`;
};

/**
 * What the host tells its tools of its home, so a `lemma` its agent runs reaches it (undefined: unset). Its kind's own
 * root and default profile go unnamed, as its `lemma` finds them by itself, so a Lemma of the other kind the agent runs
 * keeps to its own: an installed Lemma's agent's `pnpm dev`, to `~/.lemma-dev`.
 */
export const homeForTools = (paths: Pick<PathsService, "root" | "profile">, env: Env, kind: BuildKind = buildKind) =>
  paths.root === defaultRoot(env, kind) && paths.profile === undefined
    ? { LEMMA_HOME: undefined, LEMMA_PROFILE: undefined }
    : { LEMMA_HOME: paths.root, LEMMA_PROFILE: paths.profile };

/**
 * Resolve every location once. `$LEMMA_HOME` overrides the root, else its kind's (`defaultRoot`); `$LEMMA_PROFILE`
 * names a profile, whose home is `<root>/profiles/<name>` (`@lemma/contracts/profiles`); nothing else is configurable.
 * Throws for a `LEMMA_PROFILE` that is no profile name: check it first (`profileNameProblem`) to say so.
 */
export function resolvePaths(options: { readonly env: Env; readonly cwd: string; readonly kind?: BuildKind }): PathsService {
  const cwd = resolve(options.cwd);
  const configured = options.env.LEMMA_HOME?.trim();
  const root = configured ? resolve(cwd, configured) : defaultRoot(options.env, options.kind);
  const profile = profileOf(options.env);
  const problem = profile === undefined ? undefined : profileNameProblem(profile);
  if (problem !== undefined) throw new TypeError(`LEMMA_PROFILE: ${problem}`);
  const home = profileHome(root, profile);
  return {
    home,
    root,
    ...(profile === undefined ? {} : { profile }),
    userConfig: join(home, "config.jsonc"),
    projectConfig: join(cwd, ".lemma", "config.jsonc"),
    cwd,
  };
}

/** The host's own files in its home, which clients read without a host running: its lock, and its log. */
export const hostFiles = (home: string) => ({
  /** Held, with the host's pid in it, while a host runs for this home: there is one at a time (`holdHostLock`). */
  lock: join(home, "host.lock"),
  /** What the host prints, however it was started (`lemma logs`), and the run before's (`.1`). */
  log: join(home, "logs", "host.log"),
  previousLog: join(home, "logs", "host.log.1"),
  logs: join(home, "logs"),
});
