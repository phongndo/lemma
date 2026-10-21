import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { readDiscovery } from "@lemma/contracts/discovery";
import { CliError, defineBuiltin, ExitCode, usage } from "../command.ts";
import type { Builtin, Io } from "../command.ts";
import { homeOf } from "../connect.ts";
import { compareVersions, isReleaseVersion, newestRelease, readBuild, releasesApi } from "../release.ts";
import type { Build, Channel } from "../release.ts";

/*
 * This `lemma` itself: what it is, and replacing it with another release (docs/installation.md#updating). The
 * installer does the replacing, the one this release carries, so `lemma update` installs as `curl … | sh` does.
 */

const UPDATES = "Version and updates";

const INSTALL = "curl -fsSL https://raw.githubusercontent.com/phongndo/lemma/main/scripts/install.sh | sh";

const describeBuild = (build: Build): string => {
  const lines = [`Lemma ${build.version}${build.kind === "checkout" ? ", a checkout" : build.channel === undefined ? "" : ` (${build.channel})`}`];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(10)} ${value}`);
  if (build.kind === "checkout") row("checkout", `${build.root}${build.commit === undefined ? "" : `, commit ${build.commit.slice(0, 12)}`}`);
  else {
    if (build.commit !== undefined || build.built !== undefined)
      row("built", [build.commit === undefined ? undefined : `commit ${build.commit.slice(0, 12)}`, build.built].filter(Boolean).join(", "));
    row("installed", build.link === undefined ? `${build.root} (not by the installer: lemma update cannot replace it)` : `${build.root}, as ${build.link}`);
  }
  row("node", build.node);
  return lines.join("\n");
};

const version = defineBuiltin({
  path: ["version"],
  group: UPDATES,
  summary: "What this lemma is: its version, what it was built from, the channel it follows, and where it is installed",
  description:
    "lemma --version prints the version alone. A release says the commit it was built from and when, and, installed by the installer, the channel lemma update follows and the lemma it links; a checkout, its commit. lemma update --check says whether a newer release is out.",
  run: () =>
    Effect.sync(() => {
      const build = readBuild();
      return { json: build, text: describeBuild(build) };
    }),
});

/** Runs the installer `build` carries, its output on stderr; fails with what it said, when it fails. */
const runInstaller = (io: Io, build: Build & { readonly link: string; readonly dataDir: string }, channel: Channel, release: string) =>
  Effect.callback<void, CliError>((resume) => {
    const child = spawn("sh", [join(build.root, "scripts/install.sh")], {
      env: {
        ...io.env,
        LEMMA_CHANNEL: channel,
        LEMMA_VERSION: release,
        LEMMA_INSTALL_DIR: dirname(build.link),
        LEMMA_DATA_DIR: build.dataDir,
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // What it says it did is said below in this command's words; its progress and failures go to stderr as it goes.
    let said = "";
    child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (io.errWrite === undefined ? io.err(chunk.toString().trimEnd()) : io.errWrite(chunk.toString())));
    child.once("error", (error) =>
      resume(Effect.fail(new CliError({ code: "UpdateFailed", message: `Could not run the installer: ${error.message}`, exit: ExitCode.failed }))),
    );
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(
              new CliError({
                code: "UpdateFailed",
                message: `The installer failed (exit ${code}), leaving Lemma ${build.version} installed${said.trim() === "" ? "" : `:\n${said.trim()}`}`,
                exit: ExitCode.failed,
              }),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGTERM"));
  });

const update = defineBuiltin({
  path: ["update"],
  group: UPDATES,
  summary: "Install the newest release on this lemma's channel, or another channel's, or a version given",
  description:
    "It installs as the installer does, the one this release carries: the release in a directory of its own, the lemma command switched to it once it runs, the one before kept. --channel nightly follows the nightly channel from then on (the installer records it); a version installs that release, an older one rolling back. A running host keeps the release it started with until lemma restart. A checkout updates with git.",
  args: [{ name: "version", description: "The release to install, as 0.2.7, rather than the channel's newest" }],
  flags: {
    channel: {
      type: "string",
      values: ["stable", "nightly"],
      description: "Follow this channel from now on, rather than the one this lemma was installed from",
    },
    check: { type: "boolean", description: "Say whether a newer release is out on the channel, and install nothing" },
  },
  examples: ["lemma update", "lemma update --check", "lemma update --channel nightly", "lemma update 0.2.5"],
  run: ({ io, args, flags }) =>
    Effect.gen(function* () {
      const build = readBuild();
      if (build.kind === "checkout")
        return yield* new CliError({
          code: "Checkout",
          message: `This lemma runs from a checkout (${build.root}): update it with git, not lemma update`,
          exit: ExitCode.failed,
        });
      if (build.link === undefined || build.dataDir === undefined)
        return yield* new CliError({
          code: "NotInstalled",
          message: `The installer did not install this release (${build.root}), so lemma update cannot replace it; install one with: ${INSTALL}`,
          exit: ExitCode.failed,
        });
      const installed = { ...build, link: build.link, dataDir: build.dataDir };
      const channel: Channel = (flags.channel as Channel | undefined) ?? build.channel ?? "stable";
      const asked = args.version === undefined ? undefined : String(args.version).replace(/^v/, "");
      if (asked !== undefined && !isReleaseVersion(asked)) return yield* usage(`"${String(args.version)}" is not a release's version, such as 0.2.7`);
      if (asked !== undefined && flags.check) return yield* usage("--check compares with the channel's newest release: give no version with it");
      const api = releasesApi(io.env);
      const target =
        asked ??
        (yield* Effect.tryPromise({
          try: (signal) => newestRelease(api, channel, signal),
          catch: (error) =>
            new CliError({
              code: "Unreachable",
              message: `Could not ask ${api} which release is newest: ${error instanceof Error ? error.message : String(error)}`,
              exit: ExitCode.unavailable,
            }),
        }));
      if (target === undefined)
        return yield* new CliError({
          code: "NoRelease",
          message:
            channel === "stable"
              ? "No stable release is published yet: lemma update --channel nightly installs the newest nightly"
              : "No release is published yet",
          exit: ExitCode.failed,
        });
      if (flags.check) {
        const newer = compareVersions(target, build.version) > 0;
        return {
          json: { version: build.version, channel, newest: target, newer },
          text: newer
            ? `Lemma ${target} is out on ${channel}, and this is ${build.version}: lemma update installs it`
            : `Lemma ${build.version} is the newest on ${channel}`,
        };
      }
      if (target === build.version && channel === build.channel)
        return { json: { updated: false, version: build.version, channel }, text: `Lemma ${build.version} is installed already, the newest on ${channel}` };

      yield* runInstaller(io, installed, channel, target);
      const now = readBuild(dirname(dirname(realpathSync(build.link))));
      const running = yield* readDiscovery(homeOf(io));
      const lines = [`Installed Lemma ${now.version} (${channel}) as ${build.link}, in place of ${build.version}.`];
      if (running !== undefined) lines.push(`The host (pid ${running.pid}) runs the release it started with until it restarts: lemma restart`);
      return {
        json: {
          updated: true,
          from: build.version,
          version: now.version,
          channel,
          root: now.root,
          link: build.link,
          host: running === undefined ? null : { pid: running.pid },
        },
        text: lines.join("\n"),
      };
    }),
});

export const releaseCommands: readonly Builtin[] = [version, update];
