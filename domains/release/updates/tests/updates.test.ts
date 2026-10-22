import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { CliChecks } from "@lemma/cli";
import type { CheckOutcome } from "@lemma/cli";
import { Channels, Notice, resultOf } from "@lemma/contracts";
import type { ChannelCall } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { Events, makeCore, Registries } from "@lemma/core";
import { ReleaseChannels } from "@lemma/release";
import type { ReleaseStatus, UpdateResult } from "@lemma/release";
import { settled } from "../../../../scripts/e2e.ts";
import updates from "../src/index.ts";

/*
 * The plugin over two stand-ins for `lemma`: `lemma`, the one beside the host, and `link`, the one the installer links.
 * Each answers from files the test writes (`version.json`, `check.json`, `update.json`, or `error.json` for a failure),
 * logs what it was asked by its name, and to `restart` writes `restarted`, or fails when `restart-fails` exists.
 */
let dir: string;
const write = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));

const STAND_IN = `#!/bin/sh
dir=$(dirname "$0")
echo "$(basename "$0") $*" >> "$dir/asked"
if [ -f "$dir/error.json" ]; then cat "$dir/error.json" >&2; exit 3; fi
case "$1 $2" in
  "version --json") cat "$dir/version.json" ;;
  "update --check") cat "$dir/check.json" ;;
  update*) cat "$dir/update.json" ;;
  restart*)
    if [ -f "$dir/restart-fails" ]; then echo '{"error":{"code":"StillRunning","message":"The host did not stop"}}' >&2; exit 1; fi
    echo "$*" > "$dir/restarted" ;;
esac
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lemma-release-updates-"));
  for (const name of ["lemma", "link"]) {
    await writeFile(join(dir, name), STAND_IN);
    await chmod(join(dir, name), 0o755);
  }
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const release = (fields: Record<string, unknown> = {}) => ({
  version: "0.2.7",
  kind: "release",
  root: "/home/me/.local/share/lemma/releases/lemma-v0.2.7-linux-x64.AbC",
  commit: "a".repeat(40),
  built: "2026-10-21T05:41:00Z",
  installer: "script",
  update: "lemma update",
  channel: "nightly",
  link: join(dir, "link"),
  dataDir: "/home/me/.local/share/lemma",
  node: "24.22.0",
  ...fields,
});

/** What the installer's `lemma update --check` answers: its own version, the channel it follows, and that channel's newest. */
const checked = (newest: string, channel = "nightly", version = "0.2.7") => ({ version, channel, newest, newer: false });

/** Runs the plugin over the stand-ins, handing `body` its channels, its doctor check, and the notices it publishes. */
const withPlugin = <A>(
  body: (plugin: {
    readonly channels: Record<keyof typeof ReleaseChannels, ChannelCall>;
    readonly doctor: Effect.Effect<CheckOutcome, unknown>;
    readonly notices: readonly { readonly level: string; readonly message: string }[];
  }) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([pathsPlugin(join(dir, "home")), updates], { configs: { "release.updates": { cli: join(dir, "lemma"), check: false } } });
        return yield* core.run(
          Effect.gen(function* () {
            const notices: { level: string; message: string }[] = [];
            yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice))));
            yield* Effect.yieldNow;
            const registries = yield* Registries;
            const byId = new Map((yield* registries.items(Channels)).map(({ item }) => [item.id, item as ChannelCall]));
            const channels = Object.fromEntries(Object.entries(ReleaseChannels).map(([key, declaration]) => [key, byId.get(declaration.id)!]));
            const [check] = yield* registries.items(CliChecks);
            // As lemma doctor runs it: a check may answer with its outcome, a promise of it, or an Effect.
            const doctor = Effect.suspend(() => {
              const outcome = check!.item.run();
              return Effect.isEffect(outcome) ? (outcome as Effect.Effect<CheckOutcome, unknown>) : Effect.promise(() => Promise.resolve(outcome));
            });
            return yield* body({ channels: channels as Record<keyof typeof ReleaseChannels, ChannelCall>, doctor, notices });
          }),
        );
      }),
    ),
  );

const asked = async () => (await readFile(join(dir, "asked"), "utf8")).trim().split("\n");

describe("release.updates", () => {
  it("says what this host runs, from the lemma beside it, asked once", async () => {
    await write("version.json", release());
    const status = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.status, undefined);
        return (yield* resultOf(channels.status, undefined)) as ReleaseStatus;
      }),
    );
    expect(status).toEqual({ build: release(), updatable: true, channel: "nightly", newer: false });
    expect(await asked()).toEqual(["lemma version --json"]);
  });

  it("asks again what it runs when lemma could not say", async () => {
    await write("version.json", release());
    await write("error.json", { error: { code: "Failed", message: "busy" } });
    const status = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        yield* Effect.flip(resultOf(channels.status, undefined));
        yield* Effect.promise(() => rm(join(dir, "error.json")));
        return (yield* resultOf(channels.status, undefined)) as ReleaseStatus;
      }),
    );
    expect(status.build.version).toBe("0.2.7");
  });

  it("checks with the installer's lemma, following its channel, against what this host runs, and says so once", async () => {
    // A terminal's `lemma update --channel stable` installed 0.2.9 since this host started on 0.2.7 (nightly).
    await write("version.json", release());
    await write("check.json", checked("0.2.9", "stable"));
    const { status, outcome, notices } = await withPlugin(({ channels, doctor, notices }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.check, undefined);
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        const outcome = yield* doctor;
        yield* Effect.yieldNow;
        return { status, outcome, notices };
      }),
    );
    expect(status).toMatchObject({ channel: "stable", newest: "0.2.9", newer: true });
    expect(outcome).toEqual({ status: "warn", message: "Lemma 0.2.9 is out on stable, and this is 0.2.7", fix: "lemma update, then lemma restart" });
    expect(notices.map((notice) => notice.message)).toEqual(["Lemma 0.2.9 is out on stable, and this is 0.2.7: Settings › About updates to it"]);
    expect(await asked()).toContain("link update --check --json");
  });

  it("offers nothing when the channel went back to an older release: going back is lemma update <version>'s", async () => {
    await write("version.json", release({ channel: "stable" }));
    await write("check.json", checked("0.2.5", "stable"));
    const { status, outcome, notices } = await withPlugin(({ channels, doctor, notices }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        const outcome = yield* doctor;
        yield* Effect.yieldNow;
        return { status, outcome, notices };
      }),
    );
    expect(status).toMatchObject({ newest: "0.2.5", newer: false });
    expect(outcome).toEqual({ status: "ok", message: "Lemma 0.2.7: no newer release is out on stable" });
    expect(notices).toEqual([]);
  });

  it("follows no channel once the installer's lemma is pinned, installed by version", async () => {
    await write("version.json", release());
    await write("check.json", { version: "0.2.7", newer: false });
    const { status, outcome } = await withPlugin(({ channels, doctor }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        return { status, outcome: yield* doctor };
      }),
    );
    expect(status).toEqual({ build: release(), updatable: true, newer: false });
    expect(outcome).toEqual({ status: "ok", message: "Lemma 0.2.7, installed by version: it follows no channel" });
  });

  it("keeps what it found when a check fails, saying why", async () => {
    await write("version.json", release());
    await write("check.json", checked("0.2.7"));
    const status = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.check, undefined);
        yield* Effect.promise(() => write("error.json", { error: { code: "Unreachable", message: "Could not ask GitHub" } }));
        return (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
      }),
    );
    expect(status).toMatchObject({ newest: "0.2.7", newer: false, error: "lemma update --check: Could not ask GitHub" });
  });

  it("installs with the installer's lemma, then has it restart the host", async () => {
    await write("version.json", release());
    await write("update.json", { updated: true, version: "0.2.9", from: "0.2.7" });
    const result = await withPlugin(({ channels }) => Effect.map(resultOf(channels.update, { version: "0.2.9" }), (answer) => answer as UpdateResult));
    expect(result).toEqual({ version: "0.2.9", updated: true, restarting: true });
    expect(await asked()).toContain("link update 0.2.9 --json");
    // A second after answering, apart from the host.
    const restarted = await settled(() => readFile(join(dir, "restarted"), "utf8"), undefined, 10_000);
    expect(restarted?.trim()).toBe("restart --force");
  });

  it("offers what updating restarts on: the installer's lemma when it is newer than the channel's newest", async () => {
    // A terminal installed 0.2.9 since this host started on 0.2.7, and stable then went back to 0.2.8.
    await write("version.json", release({ channel: "stable" }));
    await write("check.json", checked("0.2.8", "stable", "0.2.9"));
    await write("update.json", { updated: false, version: "0.2.9", channel: "stable" });
    const { status, result } = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        return { status, result: (yield* resultOf(channels.update, {})) as UpdateResult };
      }),
    );
    expect(status).toMatchObject({ newest: "0.2.9", newer: true });
    expect(result).toEqual({ version: "0.2.9", updated: false, restarting: true });
  });

  it("lets the next update through when the restart could not be started", async () => {
    await write("version.json", release());
    await write("update.json", { updated: true, version: "0.2.9", from: "0.2.7" });
    // Where the restart's output goes is a file, so its folder cannot be made.
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "home", "logs"), "");
    const [first, second] = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        const first = yield* Effect.flip(resultOf(channels.update, {}));
        return [first, yield* Effect.flip(resultOf(channels.update, {}))] as const;
      }),
    );
    expect(first).toMatchObject({ reason: "Failed", message: expect.stringContaining("Lemma 0.2.9 is installed, but its restart could not be started") });
    expect(second).toMatchObject({ reason: "Failed" });
  });

  it("starts no second update while the first one's restart is still to come", async () => {
    await write("version.json", release());
    await write("update.json", { updated: true, version: "0.2.9", from: "0.2.7" });
    const second = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.update, {});
        // Answered, and the restart a second away.
        return yield* Effect.flip(resultOf(channels.update, {}));
      }),
    );
    expect(second).toMatchObject({ reason: "Busy" });
    await settled(() => readFile(join(dir, "restarted"), "utf8"), undefined, 10_000);
    expect((await asked()).filter((line) => line.startsWith("link "))).toEqual(["link update --json", "link restart --force"]);
  });

  it("restarts on a release a terminal installed already, and not on the one it runs", async () => {
    await write("version.json", release());
    await write("update.json", { updated: false, version: "0.2.9", channel: "nightly" });
    expect(await withPlugin(({ channels }) => resultOf(channels.update, {}))).toEqual({ version: "0.2.9", updated: false, restarting: true });
    await write("update.json", { updated: false, version: "0.2.7", channel: "nightly" });
    expect(await withPlugin(({ channels }) => resultOf(channels.update, {}))).toEqual({ version: "0.2.7", updated: false, restarting: false });
  });

  it("says why a restart failed, in its status and a notice, and where its output is", async () => {
    await write("version.json", release());
    await write("update.json", { updated: true, version: "0.2.9" });
    await writeFile(join(dir, "restart-fails"), "");
    const { status, notices } = await withPlugin(({ channels, notices }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.update, {});
        const failed = yield* Effect.promise(() =>
          settled(
            async () => {
              const now = (await Effect.runPromise(resultOf(channels.status, undefined))) as ReleaseStatus;
              return now.restartError === undefined ? undefined : now;
            },
            undefined,
            10_000,
          ),
        );
        yield* Effect.yieldNow;
        return { status: failed, notices };
      }),
    );
    const log = join(dir, "home", "logs", "restart.log");
    expect(status?.restartError).toBe(`lemma restart failed (exit 1): The host did not stop (${log})`);
    expect(notices).toContainEqual(
      expect.objectContaining({ level: "error", message: `Lemma 0.2.9 is installed, but the host did not restart on it: ${status?.restartError}` }),
    );
  });

  it("updates through the package manager that installed it, and restarts on the lemma that lemma update names", async () => {
    const brew = { installer: "homebrew", update: "brew upgrade phongndo/tap/lemma", channel: "stable", dataDir: undefined };
    await write("version.json", release(brew));
    await write("check.json", checked("0.2.9", "stable"));
    await write("update.json", { updated: true, version: "0.2.9", installer: "homebrew", command: join(dir, "lemma") });
    const { status, result } = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        return { status, result: (yield* resultOf(channels.update, {})) as UpdateResult };
      }),
    );
    expect(status).toMatchObject({ updatable: true, channel: "stable", newest: "0.2.9", newer: true });
    expect(result).toEqual({ version: "0.2.9", updated: true, restarting: true });
    await settled(() => readFile(join(dir, "restarted"), "utf8"), undefined, 10_000);
    expect(await asked()).toEqual(expect.arrayContaining(["link update --check --json", "link update --json", "lemma restart --force"]));
  });

  it("restarts the host on Homebrew's cask's new app when the host does not run in the app", async () => {
    await write(
      "version.json",
      release({ installer: "homebrew-cask", update: "brew upgrade --cask phongndo/tap/lemma", channel: "stable", dataDir: undefined }),
    );
    await write("update.json", { updated: true, version: "0.2.9", reopen: true, command: join(dir, "link") });
    expect(await withPlugin(({ channels }) => resultOf(channels.update, {}))).toEqual({ version: "0.2.9", updated: true, restarting: true });
    await settled(() => readFile(join(dir, "restarted"), "utf8"), undefined, 10_000);
    expect(await asked()).toContain("link restart --force");
  });

  it("tells of a newer release for Nix's, with how to update it, and replaces nothing", async () => {
    const how = "update the flake input that brings Lemma (nix flake update lemma) and rebuild, or: nix profile upgrade lemma";
    await write("version.json", release({ installer: "nix", update: how, channel: "stable", link: undefined, dataDir: undefined }));
    await write("check.json", checked("0.2.9", "stable"));
    const { status, update, outcome, notices } = await withPlugin(({ channels, doctor, notices }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        const update = yield* Effect.flip(resultOf(channels.update, {}));
        const outcome = yield* doctor;
        yield* Effect.yieldNow;
        return { status, update, outcome, notices };
      }),
    );
    expect(status).toMatchObject({ updatable: false, channel: "stable", newest: "0.2.9", newer: true });
    expect(update).toMatchObject({ reason: "NotInstalled", message: `This release was installed with Nix, so Lemma cannot replace it: ${how}` });
    expect(outcome).toEqual({ status: "warn", message: "Lemma 0.2.9 is out on stable, and this is 0.2.7", fix: how });
    expect(notices.map((notice) => notice.message)).toEqual([`Lemma 0.2.9 is out on stable, and this is 0.2.7: ${how}`]);
    // With no lemma of its own linked, it asks the one beside the host.
    expect(await asked()).toContain("lemma update --check --json");
  });

  it("leaves a checkout to git: nothing to check, and no update", async () => {
    await write("version.json", { version: "0.2.0", kind: "checkout", root: "/src/lemma", commit: "b".repeat(40), node: "24.21.0" });
    const { status, update, outcome } = await withPlugin(({ channels, doctor }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        const update = yield* Effect.flip(resultOf(channels.update, {}));
        const outcome = yield* doctor;
        return { status, update, outcome };
      }),
    );
    expect(status).toMatchObject({ updatable: false, newer: false });
    expect(update).toMatchObject({ reason: "Checkout" });
    expect(outcome).toEqual({ status: "ok", message: "A checkout, at 0.2.0: it updates with git" });
    expect(await asked()).toEqual(["lemma version --json"]);
  });
});
