import { join } from "node:path";
import { Effect } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import type { Registries } from "@lemma/core";
import { Channels, resultOf } from "./channels.ts";
import type { ChannelCall } from "./channels.ts";
import { Paths } from "./host.ts";
import { HostError } from "./status.ts";

/*
 * Node only, for plugins' tests: `@lemma/contracts/testing`.
 */

/** A plugin providing `Paths` as a host in `home` would, each file where the host puts it unless `paths` names it. */
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
          auth: join(home, "auth.json"),
          sessions: join(home, "sessions"),
          cwd: home,
          ...paths,
        },
      }),
  });

/**
 * Calls the channel that answers for `id` as the transport serves a client's
 * call, with values rather than JSON: within its plugin's lifetime
 * (`Registries.run`), so the plugin's disposal waits for it and its handler
 * hears the plugin leave (`CallLifetime`). Fails `NotFound` when no call
 * answers, `Withdrawn` when the handler stopped for its plugin leaving, and
 * otherwise as the handler does. Call it outside `core.run`, as the transport
 * does: a reload drains `core.run` work too.
 */
export const callServed = (registries: Context.Service.Shape<typeof Registries>, id: string, payload: unknown): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const found = (yield* registries.items(Channels)).find(({ item }) => item.id === id);
    if (found === undefined || found.item.kind !== "call") return yield* new HostError({ code: "NotFound", subject: id, message: `No call "${id}"` });
    const channel = found.item as ChannelCall;
    const withdrawn = new HostError({ code: "Withdrawn", subject: id, message: `"${id}" was withdrawn: its plugin stopped or was replaced` });
    return yield* registries.run(found, (left) => resultOf(channel, payload, { left, withdrawn }));
  });
