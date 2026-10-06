import { join } from "node:path";
import { Layer } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { Paths } from "./host.ts";

/*
 * Node only, for plugins' tests: `@lemma/contracts/testing`.
 */

/** A plugin providing `Paths` as a host in `home` would, each file where the host puts it unless `paths` names it. */
export const pathsPlugin = (home: string, paths: Partial<Context.Tag.Service<typeof Paths>> = {}) =>
  definePlugin({
    id: "paths",
    provides: [Paths],
    layer: Layer.succeed(Paths, {
      home,
      userConfig: join(home, "config.jsonc"),
      projectConfig: join(paths.cwd ?? home, ".lemma", "config.jsonc"),
      auth: join(home, "auth.json"),
      sessions: join(home, "sessions"),
      cwd: home,
      ...paths,
    }),
  });
