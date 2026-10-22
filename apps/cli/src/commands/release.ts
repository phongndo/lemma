import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { readDiscovery } from "@lemma/contracts/discovery";
import { CHANNELS, compareVersions, INSTALLER_TITLES, UPDATABLE } from "@lemma/release";
import type { Build, Channel, Installer } from "@lemma/release";
import { CliError, defineBuiltin, ExitCode, usage } from "../command.ts";
import type { Builtin, Io } from "../command.ts";
import { homeOf } from "../connect.ts";
import { brewPrefix, findCommand, INSTALL_NIGHTLY, INSTALL_SCRIPT, MISE_TOOL, miseRoot, NPM_PACKAGE, TAP } from "../installers.ts";
import { isReleaseVersion, newestRelease, readBuild, readInstall, releasesApi } from "../release.ts";

/*
 * This `lemma` itself: what it is, and replacing it with another release (docs/installation.md#updating), the way it
 * was installed: the installer this release carries, so `lemma update` installs as `curl … | sh` does, or the package
 * manager that installed it (installers.ts).
 */

const UPDATES = "Version and updates";

const describeBuild = (build: Build): string => {
  const following = build.channel ?? (build.link === undefined ? undefined : "pinned");
  const lines = [`Lemma ${build.version}${build.kind === "checkout" ? ", a checkout" : following === undefined ? "" : ` (${following})`}`];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(10)} ${value}`);
  if (build.kind === "checkout") row("checkout", `${build.root}${build.commit === undefined ? "" : `, commit ${build.commit.slice(0, 12)}`}`);
  else {
    if (build.commit !== undefined || build.built !== undefined)
      row("built", [build.commit === undefined ? undefined : `commit ${build.commit.slice(0, 12)}`, build.built].filter(Boolean).join(", "));
    row(
      "installed",
      build.installer === undefined
        ? `${build.root} (not by the installer or a package manager: lemma update cannot replace it)`
        : `${build.root}, with ${INSTALLER_TITLES[build.installer]}${build.link === undefined ? "" : `, as ${build.link}`}`,
    );
    if (build.update !== undefined) row("updates", build.update);
  }
  row("node", build.node);
  return lines.join("\n");
};

const version = defineBuiltin({
  path: ["version"],
  group: UPDATES,
  summary: "What this lemma is: its version, what it was built from, how it was installed, and how it updates",
  description:
    "lemma --version prints the version alone. A release says the commit it was built from and when, and what installed it: the installer (with the channel lemma update follows; pinned: none, installed by version, and the lemma it links), Homebrew, mise, npm, Nix, or the desktop app's download, and how it updates; a checkout, its commit. lemma update --check says whether a newer release is out.",
  run: ({ io }) =>
    Effect.sync(() => {
      const build = readBuild(undefined, io.env);
      return { json: build, text: describeBuild(build) };
    }),
});

/**
 * Runs `command` with `args`, its output on stderr, as it goes: a package manager's progress, or the installer's.
 * Answers with what it printed on stdout; fails with the end of what it said, when it fails.
 */
const runStep = (io: Io, command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>> = {}, quiet = false) =>
  Effect.callback<string, CliError>((resume) => {
    const shown = [command.split("/").at(-1), ...args].join(" ");
    const child = spawn(command, [...args], { env: { ...io.env, ...env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const say = (chunk: Buffer) => (io.errWrite === undefined ? io.err(chunk.toString().trimEnd()) : io.errWrite(chunk.toString()));
    let printed = "";
    let said = "";
    child.stdout.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
      if (!quiet) say(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString();
      say(chunk);
    });
    child.once("error", (error) =>
      resume(Effect.fail(new CliError({ code: "UpdateFailed", message: `Could not run ${shown}: ${error.message}`, exit: ExitCode.failed }))),
    );
    child.once("close", (code) => {
      if (code === 0) return resume(Effect.succeed(printed));
      const tail = (said.trim() || printed.trim()).split("\n").slice(-8).join("\n");
      resume(
        Effect.fail(new CliError({ code: "UpdateFailed", message: `${shown} failed (exit ${code})${tail === "" ? "" : `:\n${tail}`}`, exit: ExitCode.failed })),
      );
    });
    return Effect.sync(() => child.kill("SIGTERM"));
  });

const missing = (what: string, how: string) =>
  new CliError({ code: "UpdateFailed", message: `Could not find ${what}, which installed this Lemma: ${how}`, exit: ExitCode.failed });

/** Where the release a package manager or the installer installed now is, once `update` has run it. */
interface Updated {
  readonly root: string;
  /** The desktop app this release is in was replaced: it runs the new one once reopened. */
  readonly reopen?: boolean;
}

/**
 * Installs `target` the way `build` was installed: the installer it carries, with `channel` (none: pinned), or its
 * package manager, the version `asked` when one was. Homebrew's runs without its cleanup, which would remove a running
 * host's release before it restarts.
 */
const install = (
  io: Io,
  build: Build,
  installer: Installer,
  channel: Channel | undefined,
  target: string,
  asked: string | undefined,
): Effect.Effect<Updated, CliError> =>
  Effect.gen(function* () {
    const recorded = readInstall(build.root, io.env);
    switch (installer) {
      case "script": {
        const { link, dataDir } = recorded as { readonly link: string; readonly dataDir: string };
        yield* runStep(io, "sh", [join(build.root, "scripts/install.sh")], {
          LEMMA_CHANNEL: channel,
          LEMMA_VERSION: target,
          LEMMA_INSTALL_DIR: dirname(link),
          LEMMA_DATA_DIR: dataDir,
        });
        return { root: dirname(dirname(realpathSync(link))) };
      }
      case "homebrew":
      case "homebrew-cask": {
        const prefix = brewPrefix(io.env);
        const brew =
          recorded.manager ??
          findCommand("brew", io.env, [join(prefix, "bin/brew"), "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"]) ??
          (yield* missing("brew", `brew upgrade ${installer === "homebrew" ? "" : "--cask "}${TAP}/lemma`));
        const quiet = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ENV_HINTS: "1" };
        yield* runStep(io, brew, ["update", "--quiet"], quiet);
        yield* runStep(io, brew, ["upgrade", installer === "homebrew" ? "--formula" : "--cask", `${TAP}/lemma`], quiet);
        if (installer === "homebrew-cask") return { root: build.root, reopen: true };
        const link = recorded.link ?? join(prefix, "bin/lemma");
        return { root: existsSync(link) ? dirname(dirname(realpathSync(link))) : join(prefix, "opt/lemma/libexec") };
      }
      case "mise": {
        const home = io.env.HOME ?? homedir();
        const mise =
          findCommand("mise", io.env, [
            join(home, ".local/bin/mise"),
            join(brewPrefix(io.env), "bin/mise"),
            "/usr/local/bin/mise",
            join(home, ".cargo/bin/mise"),
          ]) ?? (yield* missing("mise", `mise upgrade ${MISE_TOOL}`));
        // The channel's newest as mise's config allows (`latest`, or a prefix such as 0.2); a version given, made the
        // global one. Then the one mise's config now runs, which may not be the newest it has.
        if (asked === undefined) yield* runStep(io, mise, ["upgrade", MISE_TOOL]);
        else yield* runStep(io, mise, ["use", "--global", `${MISE_TOOL}@${target}`]);
        const where = yield* Effect.result(runStep(io, mise, ["where", MISE_TOOL], {}, true));
        return { root: where._tag === "Success" && where.success.trim() !== "" ? where.success.trim() : miseRoot(build.root, target) };
      }
      case "npm": {
        const npm =
          recorded.manager ??
          findCommand("npm", io.env, [join(dirname(process.execPath), "npm")]) ??
          (yield* missing("npm", `npm install --global ${NPM_PACKAGE}`));
        yield* runStep(io, npm, [...(recorded.install ?? ["install", "--global"]), `${NPM_PACKAGE}@${target}`]);
        // The launcher, now the new version's, fetches its release the first time it runs, outside node_modules.
        const launcher = recorded.launcher ?? recorded.link ?? (yield* missing("npm's lemma", `npm install --global ${NPM_PACKAGE}`));
        const printed =
          recorded.launcher !== undefined && recorded.node !== undefined
            ? yield* runStep(io, recorded.node, [launcher, "version", "--json"], {}, true)
            : yield* runStep(io, launcher, ["version", "--json"], {}, true);
        const root = (() => {
          try {
            return (JSON.parse(printed) as { root?: unknown }).root;
          } catch {
            return undefined;
          }
        })();
        if (typeof root !== "string")
          return yield* new CliError({
            code: "UpdateFailed",
            message: `npm's lemma did not say where its release is: ${printed.trim()}`,
            exit: ExitCode.failed,
          });
        return { root };
      }
      default:
        return yield* new CliError({
          code: "NotInstalled",
          message: `lemma update cannot replace this Lemma: ${build.update ?? INSTALL_SCRIPT}`,
          exit: ExitCode.failed,
        });
    }
  });

/** Why a package manager installed another release than `target`, so `version` stays. */
const notTarget = (installer: Installer, version: string, target: string): CliError =>
  new CliError({
    code: "NotUpdated",
    message:
      installer === "homebrew" || installer === "homebrew-cask"
        ? `Homebrew's tap does not have Lemma ${target} yet, so Lemma ${version} stays: the tap takes up a release within an hour of it, so try again then`
        : installer === "mise"
          ? `mise kept Lemma ${version}, as its config asks for that one: mise use --global ${MISE_TOOL}@latest follows the newest`
          : `${INSTALLER_TITLES[installer]} installed Lemma ${version}, not ${target}`,
    exit: ExitCode.failed,
  });

/**
 * `lemma update` for the `lemma` `build` is (`readBuild`'s, this one): what `version` and `flags` ask, the way it was
 * installed.
 */
export const updateRelease = (
  io: Io,
  build: Build,
  version: unknown,
  flags: { readonly channel?: Channel | undefined; readonly check?: boolean | undefined },
) =>
  Effect.gen(function* () {
    if (build.kind === "checkout")
      return yield* new CliError({
        code: "Checkout",
        message: `This lemma runs from a checkout (${build.root}): update it with git, not lemma update`,
        exit: ExitCode.failed,
      });
    const installer = build.installer;
    if (installer === undefined)
      return yield* new CliError({
        code: "NotInstalled",
        message: `Neither the installer nor a package manager installed this release (${build.root}), so lemma update cannot replace it; install one with: ${INSTALL_SCRIPT}`,
        exit: ExitCode.failed,
      });
    const by = INSTALLER_TITLES[installer];
    // A package manager follows stable: the nightly channel is the installer's.
    if (installer !== "script" && flags.channel !== undefined && flags.channel !== "stable")
      return yield* new CliError({
        code: "Unsupported",
        message: `This Lemma was installed with ${by}, which follows the stable channel: the nightly channel comes from the installer, ${INSTALL_NIGHTLY}`,
        exit: ExitCode.failed,
      });
    // None for a pinned lemma, installed by version: it stays pinned until --channel names one.
    const channel: Channel | undefined = installer === "script" ? (flags.channel ?? build.channel) : "stable";
    const asked = version === undefined ? undefined : String(version).replace(/^v/, "");
    if (asked !== undefined && !isReleaseVersion(asked)) return yield* usage(`"${String(version)}" is not a release's version, such as 0.2.7`);
    if (asked !== undefined && flags.check) return yield* usage("--check compares with the channel's newest release: give no version with it");
    if (asked !== undefined && (installer === "homebrew" || installer === "homebrew-cask"))
      return yield* new CliError({
        code: "Unsupported",
        message: `Homebrew installs its tap's newest release, not a version given: install Lemma ${asked} with the installer instead, LEMMA_VERSION=${asked} ${INSTALL_SCRIPT}`,
        exit: ExitCode.failed,
      });
    // Nix's, and the desktop app from its file, it says how to update; whether a newer one is out it says all the same.
    if (!flags.check && !UPDATABLE.has(installer))
      return yield* new CliError({
        code: "NotInstalled",
        message: `This Lemma (${build.root}) was installed with ${by}, so lemma update cannot replace it: ${build.update ?? INSTALL_SCRIPT}`,
        exit: ExitCode.failed,
      });
    const pinned = `Lemma ${build.version} was installed by version, so it follows no channel`;
    if (channel === undefined && flags.check)
      return { json: { version: build.version, newer: false }, text: `${pinned}: lemma update --channel stable follows one, and installs its newest` };
    const api = releasesApi(io.env);
    const target =
      asked ??
      (channel === undefined
        ? yield* usage(`${pinned}: give a version to install, or --channel stable or nightly to follow one`)
        : yield* Effect.tryPromise({
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
            ? `No stable release is published yet${installer === "script" ? ": lemma update --channel nightly installs the newest nightly" : ""}`
            : "No release is published yet",
        exit: ExitCode.failed,
      });
    const order = compareVersions(target, build.version);
    if (flags.check)
      return {
        json: { version: build.version, channel, newest: target, newer: order > 0 },
        text:
          order > 0
            ? `Lemma ${target} is out on ${channel}, and this is ${build.version}: ${UPDATABLE.has(installer) ? "lemma update installs it" : (build.update ?? "")}`
            : `Lemma ${build.version}: no newer release is out on ${channel}`,
      };
    // Going back is asked for by version: a channel whose newest is older (a stable release rolled back) leaves this
    // as it is, unless it is the channel to switch to.
    if (channel === build.channel && (asked === undefined ? order <= 0 : order === 0))
      return {
        json: { updated: false, version: build.version, channel },
        text:
          order === 0
            ? `Lemma ${build.version} is installed already`
            : `Lemma ${build.version}: no newer release is out on ${channel}, whose newest is ${target}`,
      };

    const updated = yield* install(io, build, installer, channel, target, asked);
    const now = readBuild(updated.root, io.env);
    if (now.kind !== "release" || now.version !== target) return yield* notTarget(installer, now.kind === "release" ? now.version : build.version, target);
    // The lemma to restart a host with: the one the installer or package manager links, else the release's own.
    const command = now.link ?? join(now.root, "bin", "lemma");
    const running = yield* readDiscovery(homeOf(io));
    const lines = [
      installer === "script"
        ? `Installed Lemma ${now.version} (${channel ?? "pinned"}) as ${now.link}, in place of ${build.version}.`
        : `Installed Lemma ${now.version} with ${by}, in place of ${build.version}.`,
    ];
    if (updated.reopen) lines.push("The desktop app runs it once you quit and reopen it.");
    if (running !== undefined) lines.push(`The host (pid ${running.pid}) runs the release it started with until it restarts: lemma restart`);
    return {
      json: {
        updated: true,
        from: build.version,
        version: now.version,
        installer,
        channel,
        root: now.root,
        link: now.link ?? null,
        command,
        ...(updated.reopen ? { reopen: true } : {}),
        host: running === undefined ? null : { pid: running.pid },
      },
      text: lines.join("\n"),
    };
  });

const update = defineBuiltin({
  path: ["update"],
  group: UPDATES,
  summary: "Install the newest release on this lemma's channel, or another channel's, or a version given, the way it was installed",
  description:
    "It updates Lemma the way it was installed. The installer's: as the installer does, the one this release carries, the release in a directory of its own, the lemma command switched to it once it runs, the one before kept; --channel nightly follows the nightly channel from then on (the installer records it), installing its newest; a version installs that release, an older one rolling back; a lemma installed by version (pinned) follows no channel until --channel names one. A package manager's, through it, on the stable channel: Homebrew's formula or cask (brew upgrade; the tap's newest only, which it takes up within an hour of a release; the desktop app runs it once reopened), mise (mise upgrade, or mise use --global with a version), or npm (npm install --global). Nix's, or the desktop app from its file, it says how to update. With no version it installs the channel's newest only when it is newer. A running host keeps the release it started with until lemma restart. A checkout updates with git.",
  args: [{ name: "version", description: "The release to install, as 0.2.7, rather than the channel's newest" }],
  flags: {
    channel: {
      type: "string",
      values: CHANNELS,
      description: "Follow this channel from now on, rather than the one this lemma was installed from (the installer's only: a package manager's is stable)",
    },
    check: { type: "boolean", description: "Say whether a newer release is out on the channel, and install nothing" },
  },
  examples: ["lemma update", "lemma update --check", "lemma update --channel nightly", "lemma update 0.2.5"],
  run: ({ io, args, flags }) => updateRelease(io, readBuild(undefined, io.env), args.version, flags),
});

export const releaseCommands: readonly Builtin[] = [version, update];
