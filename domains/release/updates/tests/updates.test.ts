import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { CliChecks } from "@lemma/cli";
import type { CheckOutcome } from "@lemma/cli";
import { Channels, Notice, resultOf } from "@lemma/contracts";
import type { ChannelCall } from "@lemma/contracts";
import { Events, makeCore, Registries } from "@lemma/core";
import { ReleaseChannels } from "@lemma/release";
import { settled } from "../../../../scripts/e2e.ts";
import type { ReleaseStatus, UpdateResult } from "@lemma/release";
import updates from "../src/index.ts";

/*
 * The plugin over a stand-in `lemma`: a script that answers each command it is asked from files the test writes
 * (`version.json`, `check.json`, `update.json`, or `error.json` for a failure), and logs what it was asked. The `lemma`
 * the installer would link is another, which notes that it was asked to restart.
 */
let dir: string;
const write = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lemma-release-updates-"));
  await writeFile(
    join(dir, "lemma"),
    `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/asked"
if [ -f "$dir/error.json" ]; then cat "$dir/error.json" >&2; exit 3; fi
case "$1 $2" in
  "version --json") cat "$dir/version.json" ;;
  "update --check") cat "$dir/check.json" ;;
  update*) cat "$dir/update.json" ;;
esac
`,
  );
  await writeFile(join(dir, "link"), `#!/bin/sh\necho "$*" > "$(dirname "$0")/restarted"\n`);
  await chmod(join(dir, "lemma"), 0o755);
  await chmod(join(dir, "link"), 0o755);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const release = () => ({
  version: "0.2.7",
  kind: "release",
  root: "/home/me/.local/share/lemma/releases/lemma-v0.2.7-linux-x64.AbC",
  commit: "a".repeat(40),
  built: "2026-10-21T05:41:00Z",
  channel: "nightly",
  link: join(dir, "link"),
  dataDir: "/home/me/.local/share/lemma",
  node: "24.22.0",
});

/** Runs the plugin over the stand-in, handing `body` its channels, its doctor check, and the notices it publishes. */
const withPlugin = <A>(
  body: (plugin: {
    readonly channels: Record<keyof typeof ReleaseChannels, ChannelCall>;
    readonly doctor: Effect.Effect<CheckOutcome, unknown>;
    readonly notices: readonly string[];
  }) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([updates], { configs: { "release.updates": { cli: join(dir, "lemma"), check: false } } });
        return yield* core.run(
          Effect.gen(function* () {
            const notices: string[] = [];
            yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice.message))));
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
  it("says what this Lemma is, from lemma version, asking it once", async () => {
    await write("version.json", release());
    const status = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.status, undefined);
        return (yield* resultOf(channels.status, undefined)) as ReleaseStatus;
      }),
    );
    expect(status).toEqual({ build: release(), updatable: true, checks: false, newer: false, older: false });
    expect(await asked()).toEqual(["version --json"]);
  });

  it("checks for a newer release on the channel, says so once per release, and in lemma doctor", async () => {
    await write("version.json", release());
    await write("check.json", { version: "0.2.7", channel: "nightly", newest: "0.2.9", newer: true, older: false });
    const { status, outcome, notices } = await withPlugin(({ channels, doctor, notices }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.check, undefined);
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        const outcome = yield* doctor;
        yield* Effect.yieldNow;
        return { status, outcome, notices };
      }),
    );
    expect(status).toMatchObject({ newest: "0.2.9", newer: true, checkedAt: expect.any(Number) });
    expect(outcome).toEqual({ status: "warn", message: "Lemma 0.2.9 is out, and this is 0.2.7", fix: "lemma update, then lemma restart" });
    expect(notices).toEqual(["Lemma 0.2.9 is out on nightly, and this is 0.2.7: Settings › About updates to it"]);
    expect(await asked()).toContain("update --check --json");
  });

  it("says when the channel went back to an older release, as a rolled-back stable one does", async () => {
    await write("version.json", { ...release(), channel: "stable" });
    await write("check.json", { version: "0.2.7", channel: "stable", newest: "0.2.5", newer: false, older: true });
    const { status, outcome, notices } = await withPlugin(({ channels, doctor, notices }) =>
      Effect.gen(function* () {
        const status = (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
        const outcome = yield* doctor;
        yield* Effect.yieldNow;
        return { status, outcome, notices };
      }),
    );
    expect(status).toMatchObject({ newest: "0.2.5", newer: false, older: true });
    expect(outcome).toMatchObject({ status: "warn", message: "The stable release went back to 0.2.5, and this is 0.2.7" });
    expect(notices).toEqual(["The stable release went back to Lemma 0.2.5, and this is 0.2.7: Settings › About goes back to it"]);
  });

  it("keeps what it found when a check fails, saying why", async () => {
    await write("version.json", release());
    await write("check.json", { version: "0.2.7", channel: "nightly", newest: "0.2.7", newer: false, older: false });
    const status = await withPlugin(({ channels }) =>
      Effect.gen(function* () {
        yield* resultOf(channels.check, undefined);
        yield* Effect.promise(() => write("error.json", { error: { code: "Unreachable", message: "Could not ask GitHub" } }));
        return (yield* resultOf(channels.check, undefined)) as ReleaseStatus;
      }),
    );
    expect(status).toMatchObject({ newest: "0.2.7", newer: false, error: "lemma update --check: Could not ask GitHub" });
  });

  it("installs a release with lemma update, then has the installer's lemma restart the host", async () => {
    await write("version.json", release());
    await write("update.json", { updated: true, version: "0.2.9", from: "0.2.7" });
    const result = await withPlugin(({ channels }) => Effect.map(resultOf(channels.update, { version: "0.2.9" }), (answer) => answer as UpdateResult));
    expect(result).toEqual({ version: "0.2.9", updated: true, restarting: true });
    expect(await asked()).toContain("update 0.2.9 --json");
    // A second after answering, apart from the host.
    const restarted = await settled(() => readFile(join(dir, "restarted"), "utf8"), undefined, 10_000);
    expect(restarted?.trim()).toBe("restart --force");
  });

  it("restarts nothing when the release asked for is installed already", async () => {
    await write("version.json", release());
    await write("update.json", { updated: false, version: "0.2.7", channel: "nightly" });
    const result = await withPlugin(({ channels }) => resultOf(channels.update, {}));
    expect(result).toEqual({ version: "0.2.7", updated: false, restarting: false });
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
    expect(status).toMatchObject({ updatable: false, checks: false, newer: false });
    expect(update).toMatchObject({ reason: "Checkout" });
    expect(outcome).toEqual({ status: "ok", message: "A checkout, at 0.2.0: it updates with git" });
    expect(await asked()).toEqual(["version --json"]);
  });
});
