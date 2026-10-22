import { join } from "node:path";
import { Effect, Exit, Ref, Schedule, Schema } from "effect";
import { CliChecks } from "@lemma/cli";
import { Channels, Notice, Paths, serveChannel, shellWord } from "@lemma/contracts";
import { definePlugin, Events } from "@lemma/core";
import { Build, compareVersions, RELEASE_CONTRACT, ReleaseChannels, ReleaseError } from "@lemma/release";
import type { ReleaseStatus } from "@lemma/release";
import { CheckAnswer, restartLater, runLemma, UpdateAnswer } from "./lemma.ts";

const Config = Schema.Struct({
  cli: Schema.optional(Schema.String).annotate({
    title: "lemma command",
    description: "How to run the lemma command beside this host, as a shell command line: what tells this plugin what Lemma it runs. The host sets it.",
  }),
  check: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true))).annotate({
    title: "Check automatically",
    description: "Ask every few hours whether a newer release is out on this install's channel, and say so when one is.",
  }),
});

/** How often it asks, and how long after the host starts it first does, so as not to slow the start. */
const EVERY = "6 hours";
const FIRST = "1 minute";
/** How long `lemma` may take to answer, and to install a release (a download of about 100 MB). */
const ASKING_MS = 60_000;
const INSTALLING_MS = 15 * 60_000;

/** What the last check found: what the installer's lemma answered, and why the last check failed, if it did. */
interface Found {
  readonly answer?: CheckAnswer;
  readonly error?: string;
}

const installed = (build: Build): build is Build & { readonly link: string } =>
  build.kind === "release" && build.link !== undefined && build.dataDir !== undefined;

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
  implements: [RELEASE_CONTRACT],
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
    const found = yield* Ref.make<Found>({});
    const told = new Set<string>();
    // One update at a time: from installing until its restart ends.
    let updating = false;
    let restartError: string | undefined;

    const status: Effect.Effect<ReleaseStatus, ReleaseError> = Effect.gen(function* () {
      const about = yield* build;
      const { answer, error } = yield* Ref.get(found);
      // Until a check answers, the channel this release was installed from; then the installer's lemma's, none if pinned.
      const channel = answer === undefined ? about.channel : answer.channel;
      // What updating moves this host to, as `lemma update` and the restart after it do: the channel's newest, or a
      // release installed since this host started (a terminal's update) when that is newer.
      const installedSince = answer?.version !== undefined && compareVersions(answer.version, about.version) > 0 ? answer.version : undefined;
      const newest =
        installedSince !== undefined && (answer?.newest === undefined || compareVersions(installedSince, answer.newest) > 0) ? installedSince : answer?.newest;
      return {
        build: about,
        updatable: installed(about),
        newer: newest !== undefined && compareVersions(newest, about.version) > 0,
        ...(channel === undefined ? {} : { channel }),
        ...(newest === undefined ? {} : { newest }),
        ...(error === undefined ? {} : { error }),
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
      else yield* Ref.set(found, { answer: answer.success });
      const now = yield* status;
      if (now.newer && now.newest !== undefined && !told.has(now.newest)) {
        told.add(now.newest);
        yield* events.publish(Notice, {
          level: "info",
          source: plugin.id,
          message: `Lemma ${now.newest} is out on ${now.channel}, and this is ${about.version}: Settings › About updates to it`,
        });
      }
      return now;
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
        // Still updating once a restart is scheduled, until it ends: another update then would start a second restart
        // under this one. Any other way this ends, a failure or a fault included, lets the next one through.
        return yield* Effect.gen(function* () {
          const answer = yield* runLemma(shellWord(about.link), ["update", ...(version === undefined ? [] : [version])], UpdateAnswer, INSTALLING_MS);
          // What this host runs already. One installed already but not running (a terminal's `lemma update`) restarts all the same.
          if (answer.version === about.version) return { version: answer.version, updated: false, restarting: false };
          restartError = undefined;
          yield* Effect.try({
            try: () =>
              restartLater(about.link, restartLog, (why) => {
                updating = false;
                if (why === undefined) return;
                restartError = why;
                Effect.runFork(
                  events.publish(Notice, {
                    level: "error",
                    source: plugin.id,
                    message: `Lemma ${answer.version} is installed, but the host did not restart on it: ${why}`,
                  }),
                );
              }),
            catch: (cause) =>
              new ReleaseError({
                reason: "Failed",
                message: `Lemma ${answer.version} is installed, but its restart could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
          return { version: answer.version, updated: answer.updated, restarting: true };
        }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) && exit.value.restarting ? Effect.void : Effect.sync(() => (updating = false)))));
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
              : now.channel === undefined
                ? { status: "ok" as const, message: `Lemma ${now.build.version}, installed by version: it follows no channel` }
                : now.newer
                  ? {
                      status: "warn" as const,
                      message: `Lemma ${now.newest} is out on ${now.channel}, and this is ${now.build.version}`,
                      fix: "lemma update, then lemma restart",
                    }
                  : { status: "ok" as const, message: `Lemma ${now.build.version}: no newer release is out on ${now.channel}` },
        ),
    });

    // A pinned install follows no channel, so has nothing to ask about (a channel taken up in a terminal is followed
    // once the host restarts on it).
    const pinned = Effect.map(build, (about) => installed(about) && about.channel === undefined);
    if (checks)
      yield* plugin.background(
        "check for updates",
        Effect.delay(Effect.repeat(Effect.ignore(Effect.flatMap(pinned, (yes) => (yes ? Effect.void : check))), Schedule.spaced(EVERY)), FIRST),
      );
  },
});
