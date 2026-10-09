import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "effect";
import type { Paths } from "@lemma/contracts/runtime";

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
