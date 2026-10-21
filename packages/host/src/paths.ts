import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "effect";
import type { Paths } from "@lemma/contracts";
import { profileHome, profileNameProblem, profileOf } from "@lemma/contracts/profiles";

export type PathsService = Context.Service.Shape<typeof Paths>;

/**
 * Resolve every location once. `$LEMMA_HOME` overrides `~/.lemma`, the root; `$LEMMA_PROFILE` names a profile, whose
 * home is `<root>/profiles/<name>` (`@lemma/contracts/profiles`); nothing else is configurable. Throws for a
 * `LEMMA_PROFILE` that is no profile name: check it first (`profileNameProblem`) to say so.
 */
export function resolvePaths(options: { readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string }): PathsService {
  const cwd = resolve(options.cwd);
  const configured = options.env.LEMMA_HOME?.trim();
  const root = configured ? resolve(cwd, configured) : join(options.env.HOME || homedir(), ".lemma");
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
