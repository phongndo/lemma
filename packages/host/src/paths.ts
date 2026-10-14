import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "effect";
import type { Paths } from "@lemma/contracts";

export type PathsService = Context.Service.Shape<typeof Paths>;

/** Resolve every location once. `$LEMMA_HOME` overrides `~/.lemma`; nothing else is configurable. */
export function resolvePaths(options: { readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string }): PathsService {
  const cwd = resolve(options.cwd);
  const configured = options.env.LEMMA_HOME?.trim();
  const home = configured ? resolve(cwd, configured) : join(options.env.HOME || homedir(), ".lemma");
  return {
    home,
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
