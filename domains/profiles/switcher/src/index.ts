import { spawn } from "node:child_process";
import { Data, Duration, Effect, Schema, Semaphore } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, Paths, serveChannel } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import type { Discovery } from "@lemma/contracts/discovery";
import { DEFAULT_PROFILE, profileNameProblem } from "@lemma/contracts/profiles";
import { createProfile, listProfiles, portOf, readAvatar, readTitle, removeProfile, writeAvatar, writeTitle } from "@lemma/profiles/local";
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
  firstPort: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    title: "First profile port",
    description:
      "The lowest port a profile it makes listens on, each taking the next free one. The host supplies one above its own default port (7434 for an installed Lemma, 7534 for a checkout), so the two's profiles keep apart.",
  }),
});
export type Config = typeof Config.Type;

/**
 * A profile cannot be opened, stopped, or deleted: `Name`, no profile can have the name; `NotFound`, none has it;
 * `Current`, it is the profile of this host, which answers; `NotStarted` and `NotStopped`, its host did not start or
 * stop (or this plugin has no `cli` to do it with).
 */
export class ProfileUnavailable extends Data.TaggedError("ProfileUnavailable")<{
  readonly reason: "Name" | "NotFound" | "Current" | "NotStarted" | "NotStopped";
  readonly message: string;
}> {}

/** How long a profile's host has to start: `lemma serve --detach` waits 30 seconds for it, and says why it did not. */
const START_TIMEOUT: Duration.Input = "40 seconds";
/** How long a profile's host has to stop: `lemma stop` waits 45 seconds for it (the host's own limit, and a margin). */
const STOP_TIMEOUT: Duration.Input = "60 seconds";

/**
 * The profiles on this machine, for clients: lists them (`profiles.list`), opens one (`profiles.open`), starting its
 * host as `lemma serve --detach` does when none runs, makes one (`profiles.create`), renames one and changes its
 * picture (`profiles.rename`, `profiles.set-avatar`), stops one's host (`profiles.stop`), and deletes one
 * (`profiles.remove`). Its web half switches between them, and only shows itself once there is more than one.
 */
export default definePlugin({
  id: "profiles.switcher",
  uses: ["lemma/profiles@1"],
  implements: [PROFILES_CONTRACT],
  config: Config,
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const own = paths.profile ?? DEFAULT_PROFILE;
    // One start or stop at a time: two clients opening a stopped profile at once start one host.
    const changing = yield* Semaphore.make(1);

    const infoOf = (entry: ProfileEntry): Effect.Effect<ProfileInfo> =>
      Effect.map(Effect.all([readAvatar(entry.name, entry.home), readTitle(entry.home)], { concurrency: "unbounded" }), ([avatar, title]) => {
        const port = portOf(entry);
        return {
          name: entry.name,
          ...(title === undefined ? {} : { title }),
          default: entry.name === DEFAULT_PROFILE,
          current: entry.name === own,
          running: entry.running !== undefined || entry.name === own,
          ...(port === undefined ? {} : { port }),
          home: entry.home,
          avatar,
        };
      });

    /**
     * Runs the lemma command with `args` for `entry`'s profile, in this host's directory, as a host it starts runs: what
     * it said on stderr, once it ends, or `failed` with why it did not (it could not run, or took longer than `timeout`).
     */
    const lemma = (cli: string, entry: ProfileEntry, args: string, timeout: Duration.Input, failed: (message: string) => ProfileUnavailable) =>
      Effect.callback<string, ProfileUnavailable>((resume) => {
        const env: Record<string, string | undefined> = { ...process.env, LEMMA_HOME: paths.root, INIT_CWD: paths.cwd };
        if (entry.name === DEFAULT_PROFILE) delete env.LEMMA_PROFILE;
        else env.LEMMA_PROFILE = entry.name;
        const child = spawn(`${cli} ${args}`, { shell: true, cwd: paths.cwd, env, stdio: ["ignore", "ignore", "pipe"] });
        let said = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (said = `${said}${chunk}`.slice(-4_000)));
        child.once("error", (error) => resume(Effect.fail(failed(`cannot run ${cli}: ${error.message}`))));
        // `close`, not `exit`: by then what it said on stderr has all been read.
        child.once("close", () => resume(Effect.succeed(said)));
        return Effect.sync(() => void child.kill());
      }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(failed(`it took longer than ${Duration.toSeconds(timeout)} seconds`)) }));

    /** What the lemma command said, as the end of a message. */
    const saying = (said: string) => (said.trim() === "" ? "" : `: ${said.trim().replace(/^lemma: /, "")}`);

    /** Runs `lemma serve --detach` for `entry`, and reads the host it started. */
    const start = (entry: ProfileEntry): Effect.Effect<Discovery, ProfileUnavailable> => {
      const cli = owner.config.cli;
      if (cli === undefined)
        return Effect.fail(
          new ProfileUnavailable({
            reason: "NotStarted",
            message: `No host runs for the profile "${entry.name}": start it with \`lemma --profile ${entry.name} serve\``,
          }),
        );
      const notStarted = (why: string) => new ProfileUnavailable({ reason: "NotStarted", message: `The host for "${entry.name}" did not start: ${why}` });
      return changing.withPermits(1)(
        Effect.gen(function* () {
          // Started meanwhile, by another call or by hand.
          const already = yield* readDiscovery(entry.home);
          if (already !== undefined) return already;
          const said = yield* lemma(cli, entry, "serve --detach --no-open --json", START_TIMEOUT, notStarted);
          const started = yield* readDiscovery(entry.home);
          if (started !== undefined) return started;
          return yield* new ProfileUnavailable({ reason: "NotStarted", message: `The host for "${entry.name}" did not start${saying(said)}` });
        }),
      );
    };

    /**
     * Runs `lemma stop --force` for `entry`, which stops its host whoever started it (the desktop app, a service), and
     * waits for it to exit. Not this host's own, which answers.
     */
    const stop = (entry: ProfileEntry): Effect.Effect<void, ProfileUnavailable> => {
      if (entry.name === own)
        return Effect.fail(new ProfileUnavailable({ reason: "Current", message: `This is the host for "${entry.name}", which cannot stop itself from here` }));
      const notStopped = (why: string) => new ProfileUnavailable({ reason: "NotStopped", message: `The host for "${entry.name}" did not stop: ${why}` });
      return changing.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* readDiscovery(entry.home)) === undefined) return;
          const cli = owner.config.cli;
          if (cli === undefined)
            return yield* new ProfileUnavailable({
              reason: "NotStopped",
              message: `Stop the host for "${entry.name}" with \`lemma --profile ${entry.name} stop\``,
            });
          const said = yield* lemma(cli, entry, "stop --force --json", STOP_TIMEOUT, notStopped);
          if ((yield* readDiscovery(entry.home)) === undefined) return;
          return yield* new ProfileUnavailable({ reason: "NotStopped", message: `The host for "${entry.name}" did not stop${saying(said)}` });
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
      serveChannel(ProfileChannels.create, ({ name, title }) => Effect.flatMap(createProfile(paths.root, name, title, owner.config.firstPort), infoOf)),
    );
    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.rename, ({ name, title }) =>
        Effect.gen(function* () {
          const entry = yield* find(name);
          yield* writeTitle(entry.home, title);
          return yield* infoOf(entry);
        }),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.stop, ({ name }) =>
        Effect.gen(function* () {
          yield* stop(yield* find(name));
          return yield* infoOf(yield* find(name));
        }),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(ProfileChannels.remove, ({ name }) =>
        Effect.gen(function* () {
          if (name === DEFAULT_PROFILE)
            return yield* new ProfileUnavailable({
              reason: "Name",
              message: `The default profile is this machine's home itself (${paths.root}), which is never deleted`,
            });
          if (name === own)
            return yield* new ProfileUnavailable({ reason: "Current", message: `"${name}" is the profile of this host: delete it from another profile` });
          const entry = yield* find(name);
          yield* stop(entry);
          yield* removeProfile(paths.root, name);
        }),
      ),
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
