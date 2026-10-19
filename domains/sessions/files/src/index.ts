import { Effect, Schema } from "effect";
import type { Context } from "effect";
import { definePlugin, Events } from "@lemma/core";
import { Channels, Paths, secureIds } from "@lemma/contracts";
import type { IdSource } from "@lemma/contracts";
import { serveSessions, Sessions, SESSIONS_CONTRACT } from "@lemma/sessions";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { thisProcess } from "./lock.ts";
import type { Claimant } from "./lock.ts";
import { make } from "./sessions.ts";

export { encodeCwd } from "./format.ts";
export type { Claimant } from "./lock.ts";

const Config = Schema.Struct({
  unloadAfter: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 300)))
    .annotate({
      title: "Unload after",
      description: "Seconds a session may go unused before its events leave memory and its file is closed; the next use reloads it. 0 keeps sessions loaded.",
    }),
  emptyAfter: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 86_400)))
    .annotate({
      title: "Delete empty after",
      description:
        "Seconds a session nothing has gone into may stay, since it was made, before it is deleted (checked hourly): a new thread a client made and left. One kept, pinned, archived, or in use stays. 0 keeps them all.",
    }),
});
type Config = typeof Config.Type;

export interface SessionsPluginOptions {
  /** Where the files are: the real file system by default; tests pass a simulated disk (`SimDisk` in `@lemma/testing`). */
  readonly fs?: FileSystem;
  /** Where ids' random bytes come from: the system's secure source by default; a simulation passes a seeded one. */
  readonly ids?: IdSource;
  /** The process taking the sessions lock: this one by default; a simulation passes each host it starts as its own. */
  readonly claimant?: Claimant;
  /** The service as provided, given the store's: a benchmark counts the calls the agent makes, a test fails some. */
  readonly wrap?: (sessions: Context.Service.Shape<typeof Sessions>) => Context.Service.Shape<typeof Sessions>;
}

/** The plugin on what `options` gives it, and on this process and its file system for what they leave out. */
export const makeSessionsPlugin = (options: SessionsPluginOptions = {}) =>
  definePlugin({
    id: "sessions.files",
    implements: [SESSIONS_CONTRACT],
    version: "0.1.0",
    config: Config,
    provides: { sessions: Sessions },
    requires: { paths: Paths },
    // Two instances must not write one directory: a reload stops this one (closing its files and releasing the
    // lock) before it starts the next.
    exclusive: true,
    setup: function* (_, owner) {
      const sessions = yield* make({
        ...owner.config,
        fs: options.fs ?? nodeFileSystem,
        ids: options.ids ?? secureIds,
        claimant: options.claimant ?? thisProcess,
      });
      const provided = options.wrap?.(sessions) ?? sessions;
      // How clients reach them: the transport serves what `Channels` holds.
      for (const channel of serveSessions(provided, yield* Events)) yield* owner.add(Channels, channel);
      return { sessions: provided };
    },
  });

export default makeSessionsPlugin();
