import { join } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import type { Registries } from "@lemma/core";
import { resultOf, withChannel, withdrawnFrom } from "./channels.ts";
import { HostControl, Paths } from "./host.ts";
import type { PluginInfo } from "./host.ts";

/*
 * Node only, for plugins' tests: `@lemma/contracts/testing`.
 */

/** A plugin providing `Paths` as a host in `home` would, each location where the host puts it unless `paths` names it. */
export const pathsPlugin = (home: string, paths: Partial<Context.Service.Shape<typeof Paths>> = {}) =>
  definePlugin({
    id: "paths",
    provides: { paths: Paths },
    setup: () =>
      Effect.succeed({
        paths: {
          home,
          userConfig: join(home, "config.jsonc"),
          projectConfig: join(paths.cwd ?? home, ".lemma", "config.jsonc"),
          cwd: home,
          ...paths,
        },
      }),
  });

/** A plugin providing `HostControl` with `plugins` as its plugins, for a plugin that reads them; the rest is unused. */
export const hostControlPlugin = (plugins: readonly PluginInfo[] = []) =>
  definePlugin({
    id: "host",
    provides: { host: HostControl },
    setup: () =>
      Effect.succeed({
        host: {
          runtime: [HostControl.key],
          process: { pid: process.pid, startedAt: 0 },
          plugins: Effect.succeed(plugins),
          composition: Effect.succeed({ id: "test", plugins: [] }),
          restart: () => Effect.succeed({}),
          reload: Effect.die("unused"),
          configure: () => Effect.die("unused"),
          web: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
        },
      }),
  });

/**
 * Calls the channel that answers for `id` as the transport serves a client's
 * call (`withChannel`, `resultOf`), with values rather than JSON: within its
 * plugin's lifetime, so the plugin's disposal waits for it and its handler
 * hears the plugin leave (`CallLifetime`), and a `repeatable` call withdrawn
 * so is made again (`withChannel`). Fails as a client's call does,
 * `NotFound` when no call answers and `Withdrawn` when the handler stopped
 * for its plugin leaving or outlived its dispose deadline (and, repeatable,
 * nothing answered once that change finished), except that the handler's own failure is
 * left as it is, where a client gets it as a `HostError` with its code. Call
 * it outside `core.run`, as the transport does: a reload drains `core.run`
 * work too.
 */
export const callServed = (registries: Context.Service.Shape<typeof Registries>, id: string, payload: unknown): Effect.Effect<unknown, unknown> =>
  withChannel(registries, id, "call", ({ item }, left) => resultOf(item, payload, { left, withdrawn: withdrawnFrom(id, "call") }));
