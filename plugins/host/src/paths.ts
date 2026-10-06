import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import type { Context } from "effect";
import type { Paths } from "@lemma/contracts";

export type PathsService = Context.Service.Shape<typeof Paths>;

/** The host plugin's config: the resolved locations, so the composition data records them. */
export const PathsSchema = Schema.Struct({
  home: Schema.String,
  userConfig: Schema.String,
  projectConfig: Schema.String,
  auth: Schema.String,
  sessions: Schema.String,
  cwd: Schema.String,
});

/** Resolve every location once. `$LEMMA_HOME` overrides `~/.lemma`; nothing else is configurable. */
export function resolvePaths(options: { readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string }): PathsService {
  const cwd = resolve(options.cwd);
  const configured = options.env.LEMMA_HOME?.trim();
  const home = configured ? resolve(cwd, configured) : join(options.env.HOME || homedir(), ".lemma");
  return {
    home,
    userConfig: join(home, "config.jsonc"),
    projectConfig: join(cwd, ".lemma", "config.jsonc"),
    auth: join(home, "auth.json"),
    sessions: join(home, "sessions"),
    cwd,
  };
}
