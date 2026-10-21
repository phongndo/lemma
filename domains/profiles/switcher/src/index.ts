import { spawn } from "node:child_process";
import { Data, Effect, Schema, Semaphore } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, Paths, serveChannel } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery } from "@lemma/contracts/discovery";
import { DEFAULT_PROFILE, profileNameProblem } from "@lemma/contracts/profiles";
import { createProfile, listProfiles, portOf, readAvatar, writeAvatar } from "@lemma/profiles/local";
import type { ProfileEntry } from "@lemma/profiles/local";
import { ProfileChannels, PROFILES_CONTRACT } from "@lemma/profiles";
import type { ProfileInfo } from "@lemma/profiles";

/** Its row in config.jsonc's `plugins`. */
export const Config = Schema.Struct({
  cli: Schema.optional(Schema.String).annotate({
    title: "lemma command",
    description:
      "How to run the lemma command, which starts a profile's host (`serve --detach`). The host supplies its own; without one, a profile is opened only while its host runs.",
  }),
});
export type Config = typeof Config.Type;

/**
 * A profile cannot be opened: `Name`, no profile can have the name; `NotFound`, none has it; `NotStarted`, its host
 * did not start (or this plugin has no `cli` to start it with).
 */
export class ProfileUnavailable extends Data.TaggedError("ProfileUnavailable")<{
  readonly reason: "Name" | "NotFound" | "NotStarted";
  readonly message: string;
}> {}

/** How long a profile's host has to start: `lemma serve --detach` waits 30 seconds for it, and says why it did not. */
const START_TIMEOUT = "40 seconds";

/**
 * The profiles on this machine, for clients: lists them (`profiles.list`), opens one (`profiles.open`), starting its
 * host as `lemma serve --detach` does when none runs, makes one (`profiles.create`), and changes one's picture
 * (`profiles.set-avatar`). Its web half switches between
 * them, and only shows itself once there is more than one.
 */
export default definePlugin({
  id: "profiles.switcher",
  uses: ["lemma/profiles@1"],
  implements: [PROFILES_CONTRACT],
  config: Config,
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const own = paths.profile ?? DEFAULT_PROFILE;
    // One start at a time: two clients opening a stopped profile at once start one host.
    const starting = yield* Semaphore.make(1);

    const infoOf = (entry: ProfileEntry): Effect.Effect<ProfileInfo> =>
      Effect.map(readAvatar(entry.name, entry.home), (avatar) => {
        const port = portOf(entry);
        return {
          name: entry.name,
          default: entry.name === DEFAULT_PROFILE,
          current: entry.name === own,
          running: entry.running !== undefined || entry.name === own,
          ...(port === undefined ? {} : { port }),
          avatar,
        };
      });

    /** Runs `lemma serve --detach` for `entry`, in this host's directory, and reads the host it started. */
    const start = (entry: ProfileEntry): Effect.Effect<Discovery, ProfileUnavailable> => {
      const cli = owner.config.cli;
      if (cli === undefined)
        return Effect.fail(
          new ProfileUnavailable({
            reason: "NotStarted",
            message: `No host runs for the profile "${entry.name}": start it with \`lemma --profile ${entry.name} serve\``,
          }),
        );
      const run = Effect.callback<string, ProfileUnavailable>((resume) => {
        const env: Record<string, string | undefined> = { ...process.env, LEMMA_HOME: paths.root, INIT_CWD: paths.cwd };
        if (entry.name === DEFAULT_PROFILE) delete env.LEMMA_PROFILE;
        else env.LEMMA_PROFILE = entry.name;
        const child = spawn(`${cli} serve --detach --no-open --json`, { shell: true, cwd: paths.cwd, env, stdio: ["ignore", "ignore", "pipe"] });
        let said = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (said = `${said}${chunk}`.slice(-4_000)));
        child.once("error", (error) => resume(Effect.fail(new ProfileUnavailable({ reason: "NotStarted", message: `Cannot run ${cli}: ${error.message}` }))));
        // `close`, not `exit`: by then what it said on stderr has all been read.
        child.once("close", () => resume(Effect.succeed(said)));
        return Effect.sync(() => void child.kill());
      });
      return starting.withPermits(1)(
        Effect.gen(function* () {
          // Started meanwhile, by another call or by hand.
          const already = yield* readDiscovery(entry.home);
          if (already !== undefined) return already;
          const said = yield* run.pipe(
            Effect.timeoutOrElse({
              duration: START_TIMEOUT,
              orElse: () => Effect.fail(new ProfileUnavailable({ reason: "NotStarted", message: `The host for "${entry.name}" did not start in time` })),
            }),
          );
          const started = yield* readDiscovery(entry.home);
          if (started !== undefined) return started;
          return yield* new ProfileUnavailable({
            reason: "NotStarted",
            message: `The host for "${entry.name}" did not start${said.trim() === "" ? "" : `: ${said.trim().replace(/^lemma: /, "")}`}`,
          });
        }),
      );
    };

    const find = (name: string) =>
      Effect.gen(function* () {
        const problem = name === DEFAULT_PROFILE ? undefined : profileNameProblem(name);
        if (problem !== undefined) return yield* new ProfileUnavailable({ reason: "Name", message: problem });
        const entry = (yield* listProfiles(paths.root)).find((candidate) => candidate.name === name);
        if (entry === undefined)
          return yield* new ProfileUnavailable({ reason: "NotFound", message: `No profile "${name}"; \`lemma profile create ${name}\` makes one` });
        return entry;
      });

    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.list, () => Effect.flatMap(listProfiles(paths.root), (entries) => Effect.forEach(entries, infoOf))),
    );
    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.open, ({ name }) =>
        Effect.gen(function* () {
          const entry = yield* find(name);
          // Its own: this host, which answers.
          const running = entry.running ?? (yield* start(entry));
          return { name, url: running.url, port: Number(new URL(running.url).port), token: running.token };
        }),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.create, ({ name }) => Effect.flatMap(createProfile(paths.root, name), infoOf)),
    );
    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.setAvatar, ({ name, avatar }) =>
        Effect.gen(function* () {
          const entry = yield* find(name);
          yield* writeAvatar(entry.home, avatar);
          return yield* infoOf(entry);
        }),
      ),
    );
  },
});
