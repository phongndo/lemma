import { join } from "node:path";
import { Effect, Ref, Schedule, Schema } from "effect";
import { CliChecks } from "@lemma/cli";
import { Channels, Notice, Paths, serveChannel, shellWord } from "@lemma/contracts";
import { definePlugin, Events } from "@lemma/core";
import { Build, ReleaseChannels, ReleaseError } from "@lemma/release";
import type { ReleaseStatus } from "@lemma/release";
import { CheckAnswer, restartLater, runLemma, UpdateAnswer } from "./lemma.ts";

const Config = Schema.Struct({
  cli: Schema.optional(Schema.String).annotate({
    title: "lemma command",
    description: "How to run the lemma command beside this host, as a shell command line: what tells this plugin what Lemma it runs. The host sets it.",
  }),
  check: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Check for updates",
    description: "Ask every few hours whether a newer release is out on this install's channel, and say so when one is.",
  }),
});

/** How often it asks, and how long after the host starts it first does, so as not to slow the start. */
const EVERY = "6 hours";
const FIRST = "1 minute";
/** How long `lemma` may take to answer, and to install a release (a download of about 100 MB). */
const ASKING_MS = 60_000;
const INSTALLING_MS = 15 * 60_000;

/** What the last check found, relative to the release this host runs. */
interface Found {
  readonly newest?: string;
  readonly newer: boolean;
  readonly older: boolean;
  readonly channel?: "stable" | "nightly";
  readonly checkedAt?: number;
  readonly error?: string;
}

const installed = (build: Build): build is Build & { readonly link: string } =>
  build.kind === "release" && build.link !== undefined && build.dataDir !== undefined;

const parts = (version: string) => version.split(".", 3).map((part) => Number.parseInt(part, 10) || 0);
/** Below zero when `a` is the older release, above when the newer. */
const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * What this Lemma is, and updating it (`ReleaseChannels`): what `lemma version` says, a check now and then for a newer
 * release on the install's channel (`lemma update --check`), said once per release as a notice and in `lemma doctor`,
 * and installing one, after which the host restarts on it (`lemma update`, then `lemma restart`). It asks the `lemma`
 * command for all of it, which knows a release from a checkout and how to replace one: the one beside the host for
 * what it runs, and the one the installer links, the release installed last, for the channel and what to install.
 */
export default definePlugin({
  id: "release.updates",
  version: "0.1.0",
  config: Config,
  requires: { paths: Paths },
  setup: function* ({ paths }, plugin) {
    const { cli, check: checks } = plugin.config;
    if (cli === undefined)
      return yield* new ReleaseError({ reason: "Failed", message: "release.updates needs cli, how to run the lemma command; the host sets it" });
    const events = yield* Events;
    const restartLog = join(paths.home, "logs", "restart.log");
    // What this Lemma is does not change while it runs; a failure to say is asked again next time.
    let known: Build | undefined;
    const build = Effect.suspend(() =>
      known !== undefined ? Effect.succeed(known) : Effect.tap(runLemma(cli, ["version"], Build, ASKING_MS), (about) => Effect.sync(() => (known = about))),
    );
    const found = yield* Ref.make<Found>({ newer: false, older: false });
    const told = new Set<string>();
    let updating = false;
    let restartError: string | undefined;

    const status: Effect.Effect<ReleaseStatus, ReleaseError> = Effect.gen(function* () {
      const about = yield* build;
      const { channel, ...last } = yield* Ref.get(found);
      const following = channel ?? about.channel;
      return {
        build: about,
        updatable: installed(about),
        checks: checks && installed(about),
        ...last,
        ...(following === undefined ? {} : { channel: following }),
        ...(restartError === undefined ? {} : { restartError }),
      };
    });

    // The installer's lemma, not this host's: after `lemma update --channel` in a terminal, it follows the new channel.
    const check = Effect.gen(function* () {
      const about = yield* build;
      // A checkout updates with git, and a release the installer did not install is not lemma update's to replace.
      if (!installed(about)) return yield* status;
      const answer = yield* Effect.result(runLemma(shellWord(about.link), ["update", "--check"], CheckAnswer, ASKING_MS));
      if (answer._tag === "Failure") yield* Ref.update(found, (last) => ({ ...last, error: answer.failure.message }));
      else {
        const { newest, channel } = answer.success;
        const order = compareVersions(newest, about.version);
        yield* Ref.set(found, { newest, newer: order > 0, older: order < 0, channel, checkedAt: Date.now() });
        if (order !== 0 && !told.has(newest)) {
          told.add(newest);
          yield* events.publish(Notice, {
            level: "info",
            source: plugin.id,
            message:
              order > 0
                ? `Lemma ${newest} is out on ${channel}, and this is ${about.version}: Settings › About updates to it`
                : `The ${channel} release went back to Lemma ${newest}, and this is ${about.version}: Settings › About goes back to it`,
          });
        }
      }
      return yield* status;
    });

    const update = (version: string | undefined) =>
      Effect.gen(function* () {
        const about = yield* build;
        if (about.kind === "checkout")
          return yield* new ReleaseError({ reason: "Checkout", message: `This host runs from a checkout (${about.root}): update it with git` });
        if (!installed(about))
          return yield* new ReleaseError({
            reason: "NotInstalled",
            message: `The installer did not install this release (${about.root}), so it cannot replace it`,
          });
        if (updating) return yield* new ReleaseError({ reason: "Busy", message: "An update is under way already" });
        updating = true;
        const answer = yield* runLemma(shellWord(about.link), ["update", ...(version === undefined ? [] : [version])], UpdateAnswer, INSTALLING_MS).pipe(
          Effect.ensuring(Effect.sync(() => (updating = false))),
        );
        // What this host runs already. One installed already but not running (a terminal's `lemma update`) restarts all the same.
        if (answer.version === about.version) return { version: answer.version, updated: false, restarting: false };
        restartError = undefined;
        restartLater(about.link, restartLog, (why) => {
          restartError = why;
          Effect.runFork(
            events.publish(Notice, {
              level: "error",
              source: plugin.id,
              message: `Lemma ${answer.version} is installed, but the host did not restart on it: ${why}`,
            }),
          );
        });
        return { version: answer.version, updated: answer.updated, restarting: true };
      });

    yield* plugin.add(
      Channels,
      serveChannel(ReleaseChannels.status, () => status),
    );
    yield* plugin.add(
      Channels,
      serveChannel(ReleaseChannels.check, () => check),
    );
    yield* plugin.add(
      Channels,
      serveChannel(ReleaseChannels.update, ({ version }) => update(version)),
    );
    yield* plugin.add(CliChecks, {
      id: "release.updates",
      title: "Updates",
      run: () =>
        Effect.map(check, (now) =>
          !now.updatable
            ? {
                status: "ok" as const,
                message:
                  now.build.kind === "checkout"
                    ? `A checkout, at ${now.build.version}: it updates with git`
                    : `Lemma ${now.build.version}, not installed by the installer`,
              }
            : now.error !== undefined
              ? { status: "warn" as const, message: `Could not ask whether a newer release is out: ${now.error}` }
              : now.newer || now.older
                ? {
                    status: "warn" as const,
                    message: now.newer
                      ? `Lemma ${now.newest} is out, and this is ${now.build.version}`
                      : `The ${now.channel ?? "stable"} release went back to ${now.newest}, and this is ${now.build.version}`,
                    fix: "lemma update, then lemma restart",
                  }
                : { status: "ok" as const, message: `Lemma ${now.build.version}, the newest on ${now.channel ?? "its channel"}` },
        ),
    });

    if (checks) yield* plugin.background("check for updates", Effect.delay(Effect.repeat(Effect.ignore(check), Schedule.spaced(EVERY)), FIRST));
  },
});
