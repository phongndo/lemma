import { Effect, Layer, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Paths, Sessions } from "@lemma/contracts";
import { nodeFileSystem } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { make } from "./sessions.ts";

export { encodeCwd } from "./format.ts";

const Config = Schema.Struct({
  unloadAfter: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 300)))
    .annotate({
      title: "Unload after",
      description: "Seconds a session may go unused before its events leave memory and its file is closed; the next use reloads it. 0 keeps sessions loaded.",
    }),
});
type Config = typeof Config.Type;

/** The plugin on `fs`: the real file system by default; tests pass a simulated disk (`SimDisk` in `@lemma/testing`). */
export const makeSessionsPlugin = (options: { readonly fs?: FileSystem } = {}) =>
  definePlugin({
    id: "sessions",
    version: "0.1.0",
    config: Config,
    provides: [Sessions],
    requires: [Paths],
    // Two instances must not write one directory: a reload stops this one (closing its files and releasing the
    // lock) before it starts the next.
    exclusive: true,
    layer: (config: Config) => Layer.effect(Sessions, make({ ...config, fs: options.fs ?? nodeFileSystem })),
  });

export default makeSessionsPlugin();
