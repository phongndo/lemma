import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore, Registries } from "@lemma/core";
import { callServed, pathsPlugin } from "@lemma/contracts/testing";
import { discoveryPath } from "@lemma/contracts/discovery";
import type { OpenedProfile, ProfileInfo } from "@lemma/profiles";
import switcher from "../src/index.ts";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "lemma-profiles-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const homeOf = (profile: string | undefined) => (profile === undefined ? root : path.join(root, "profiles", profile));

/** Calls `id` as a client of a host running for `profile` (the default when undefined) does. */
const call = (id: string, payload: unknown, options: { readonly config?: Readonly<Record<string, unknown>>; readonly profile?: string } = {}) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const paths = pathsPlugin(homeOf(options.profile), { root, ...(options.profile === undefined ? {} : { profile: options.profile }) });
        const core = yield* makeCore([paths, switcher], { configs: { "profiles.switcher": options.config ?? {} } });
        return yield* callServed(yield* core.run(Registries), id, payload);
      }),
    ),
  );
const ok = async <A>(exit: Promise<Exit.Exit<unknown, unknown>>): Promise<A> => {
  const done = await exit;
  if (Exit.isFailure(done)) throw Cause.squash(done.cause);
  return done.value as A;
};
const failure = async (exit: Promise<Exit.Exit<unknown, unknown>>) => {
  const done = await exit;
  return Exit.isFailure(done) ? Cause.squash(done.cause) : undefined;
};

/** A host running for `profile`, as its transport says so: its discovery file, naming a live process (this one). */
const running = (profile: string | undefined, port: number) =>
  fs.writeFile(
    discoveryPath(homeOf(profile)),
    JSON.stringify({ url: `http://127.0.0.1:${port}`, token: `token-${profile ?? "default"}`, pid: process.pid, startedAt: 1 }),
  );

describe("profiles.switcher", () => {
  it("lists the default first, then the profiles made, each with a port of its own and whether its host runs", async () => {
    const made = await ok<ProfileInfo>(call("profiles.create", { name: "work" }));
    expect(made).toMatchObject({ name: "work", default: false, current: false, running: false });
    await ok(call("profiles.create", { name: "desk" }));
    await running("desk", 9000);
    const listed = await ok<readonly ProfileInfo[]>(call("profiles.list", undefined));
    expect(listed.map(({ name, current, running }) => ({ name, current, running }))).toEqual([
      { name: "default", current: true, running: true },
      { name: "desk", current: false, running: true },
      { name: "work", current: false, running: false },
    ]);
    // Each kept its own port; a running one's is its host's.
    expect(listed[1]?.port).toBe(9000);
    expect(listed[2]?.port).toBeGreaterThanOrEqual(7434);
    // As a host for another profile lists them: that one is its own.
    const fromDesk = await ok<readonly ProfileInfo[]>(call("profiles.list", undefined, { profile: "desk" }));
    expect(fromDesk.find((profile) => profile.current)?.name).toBe("desk");
  });

  it("refuses to make a profile twice, or one named default or no name at all", async () => {
    await ok(call("profiles.create", { name: "work" }));
    expect(await failure(call("profiles.create", { name: "work" }))).toMatchObject({ reason: "Exists" });
    expect(await failure(call("profiles.create", { name: "default" }))).toMatchObject({ reason: "Name" });
    expect(await failure(call("profiles.create", { name: "../up" }))).toMatchObject({ reason: "Name" });
  });

  it("opens a profile whose host runs: its address on its machine, its port, and its token", async () => {
    await ok(call("profiles.create", { name: "desk" }));
    await running("desk", 9001);
    expect(await ok<OpenedProfile>(call("profiles.open", { name: "desk" }))).toEqual({
      name: "desk",
      url: "http://127.0.0.1:9001",
      port: 9001,
      token: "token-desk",
    });
    // And the default, from another profile's host.
    await running(undefined, 7433);
    expect(await ok<OpenedProfile>(call("profiles.open", { name: "default" }, { profile: "desk" }))).toMatchObject({ port: 7433, token: "token-default" });
  });

  it("starts a profile's host with the lemma command when none runs", async () => {
    await ok(call("profiles.create", { name: "desk" }));
    // A lemma command that starts a host as `serve --detach` does: its discovery file in the profile's home.
    const cli = path.join(root, "fake-lemma.mjs");
    await fs.writeFile(
      cli,
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'if (process.argv.slice(2).join(" ") !== "serve --detach --no-open --json") process.exit(2);',
        'const home = join(process.env.LEMMA_HOME, "profiles", process.env.LEMMA_PROFILE);',
        'writeFileSync(join(home, "transport.json"), JSON.stringify({ url: "http://127.0.0.1:9002", token: "started", pid: Number(process.env.LEMMA_TEST_PID), startedAt: 1 }));',
      ].join("\n"),
    );
    process.env.LEMMA_TEST_PID = String(process.pid);
    try {
      const opened = await ok<OpenedProfile>(call("profiles.open", { name: "desk" }, { config: { cli: `node ${JSON.stringify(cli)}` } }));
      expect(opened).toEqual({ name: "desk", url: "http://127.0.0.1:9002", port: 9002, token: "started" });
    } finally {
      delete process.env.LEMMA_TEST_PID;
    }
  });

  it("says what is wrong when it cannot open one", async () => {
    await ok(call("profiles.create", { name: "desk" }));
    expect(await failure(call("profiles.open", { name: "desk" }))).toMatchObject({
      reason: "NotStarted",
      message: expect.stringContaining("lemma --profile desk serve"),
    });
    expect(await failure(call("profiles.open", { name: "nobody" }))).toMatchObject({ reason: "NotFound" });
    expect(await failure(call("profiles.open", { name: "No Name" }))).toMatchObject({ reason: "Name" });
    const failing = path.join(root, "failing-lemma.mjs");
    await fs.writeFile(failing, 'console.error("lemma: the host did not start: port taken"); process.exit(1);');
    expect(await failure(call("profiles.open", { name: "desk" }, { config: { cli: `node ${JSON.stringify(failing)}` } }))).toMatchObject({
      reason: "NotStarted",
      message: 'The host for "desk" did not start: the host did not start: port taken',
    });
  });

  it("gives a profile its name's pattern until another pattern or a picture of its own is chosen, and back", async () => {
    await ok(call("profiles.create", { name: "desk" }));
    const avatarOf = async () => (await ok<readonly ProfileInfo[]>(call("profiles.list", undefined))).find((profile) => profile.name === "desk")?.avatar;
    expect(await avatarOf()).toEqual({ kind: "pattern", seed: "desk" });
    expect(await ok<ProfileInfo>(call("profiles.set-avatar", { name: "desk", avatar: { kind: "pattern", seed: "abc123" } }))).toMatchObject({
      avatar: { kind: "pattern", seed: "abc123" },
    });
    expect(await avatarOf()).toEqual({ kind: "pattern", seed: "abc123" });
    // A picture of its own: kept in its home as a file, served back as it came.
    const png = `data:image/png;base64,${Buffer.from("\x89PNG fake bytes").toString("base64")}`;
    await ok(call("profiles.set-avatar", { name: "desk", avatar: { kind: "picture", url: png } }));
    expect(await avatarOf()).toEqual({ kind: "picture", url: png });
    expect((await fs.readdir(homeOf("desk"))).filter((file) => file.startsWith("avatar"))).toEqual(["avatar.json", "avatar.png"]);
    // What is no picture it takes is refused, and leaves the picture as it was.
    for (const url of ["data:image/svg+xml;base64,PHN2Zy8+", "https://example.com/me.png", `data:image/png;base64,${"A".repeat(800_000)}`])
      expect(await failure(call("profiles.set-avatar", { name: "desk", avatar: { kind: "picture", url } }))).toMatchObject({ reason: "Picture" });
    expect(await avatarOf()).toEqual({ kind: "picture", url: png });
    await ok(call("profiles.set-avatar", { name: "desk", avatar: { kind: "default" } }));
    expect(await avatarOf()).toEqual({ kind: "pattern", seed: "desk" });
    expect((await fs.readdir(homeOf("desk"))).filter((file) => file.startsWith("avatar"))).toEqual([]);
    expect(await failure(call("profiles.set-avatar", { name: "nobody", avatar: { kind: "default" } }))).toMatchObject({ reason: "NotFound" });
  });

  it("shows a profile by the name it was given, any text, until a blank one gives it back its own", async () => {
    const titleOf = async (name: string) =>
      (await ok<readonly ProfileInfo[]>(call("profiles.list", undefined))).find((profile) => profile.name === name)?.title;
    expect(await ok<ProfileInfo>(call("profiles.create", { name: "trading-desk", title: "  Trading desk 📈 " }))).toMatchObject({
      name: "trading-desk",
      title: "Trading desk 📈",
    });
    expect(await ok<ProfileInfo>(call("profiles.rename", { name: "trading-desk", title: "Markets" }))).toMatchObject({
      name: "trading-desk",
      title: "Markets",
    });
    expect(await titleOf("trading-desk")).toBe("Markets");
    // The default too, which is the home itself.
    await ok(call("profiles.rename", { name: "default", title: "Workbench" }));
    expect(await titleOf("default")).toBe("Workbench");
    await ok(call("profiles.rename", { name: "default", title: "  " }));
    expect(await titleOf("default")).toBeUndefined();
    expect(await fs.readdir(root)).not.toContain("title.json");
    // What is no name is refused, and leaves the one it had.
    for (const title of ["two\nlines", "x".repeat(61)])
      expect(await failure(call("profiles.rename", { name: "trading-desk", title }))).toMatchObject({ reason: "Title" });
    expect(await titleOf("trading-desk")).toBe("Markets");
    expect(await failure(call("profiles.create", { name: "other", title: "tab\there" }))).toMatchObject({ reason: "Title" });
    expect(await failure(call("profiles.rename", { name: "nobody", title: "Who" }))).toMatchObject({ reason: "NotFound" });
  });

  /** A lemma command that stops a profile's host as `stop --force` does: its discovery file goes. */
  const stopper = async () => {
    const cli = path.join(root, "stopping-lemma.mjs");
    await fs.writeFile(
      cli,
      [
        'import { rmSync } from "node:fs";',
        'import { join } from "node:path";',
        'if (process.argv.slice(2).join(" ") !== "stop --force --json") process.exit(2);',
        'rmSync(join(process.env.LEMMA_HOME, "profiles", process.env.LEMMA_PROFILE, "transport.json"));',
      ].join("\n"),
    );
    return { cli: `node ${JSON.stringify(cli)}` };
  };

  it("stops another profile's host with the lemma command, and never its own", async () => {
    await ok(call("profiles.create", { name: "desk" }));
    await running("desk", 9003);
    expect(await ok<ProfileInfo>(call("profiles.stop", { name: "desk" }, { config: await stopper() }))).toMatchObject({ name: "desk", running: false });
    // Stopped already, it has nothing to do.
    expect(await ok<ProfileInfo>(call("profiles.stop", { name: "desk" }))).toMatchObject({ running: false });
    await running("desk", 9003);
    expect(await failure(call("profiles.stop", { name: "desk" }))).toMatchObject({
      reason: "NotStopped",
      message: expect.stringContaining("lemma --profile desk stop"),
    });
    expect(await failure(call("profiles.stop", { name: "desk" }, { profile: "desk" }))).toMatchObject({ reason: "Current" });
  });

  it("deletes another profile and everything in its home, stopping its host first, but never the default or its own", async () => {
    await ok(call("profiles.create", { name: "desk", title: "Desk" }));
    await fs.writeFile(path.join(homeOf("desk"), "auth.json"), "{}");
    await ok(call("profiles.remove", { name: "desk" }));
    expect(await fs.readdir(path.join(root, "profiles"))).toEqual([]);
    // A running one is stopped first.
    await ok(call("profiles.create", { name: "desk" }));
    await running("desk", 9004);
    expect(await failure(call("profiles.remove", { name: "desk" }))).toMatchObject({ reason: "NotStopped" });
    expect(await fs.readdir(path.join(root, "profiles"))).toEqual(["desk"]);
    await ok(call("profiles.remove", { name: "desk" }, { config: await stopper() }));
    expect(await fs.readdir(path.join(root, "profiles"))).toEqual([]);
    // Not the home itself, nor the profile of the host asked.
    expect(await failure(call("profiles.remove", { name: "default" }, { profile: "desk" }))).toMatchObject({ reason: "Name" });
    await ok(call("profiles.create", { name: "desk" }));
    expect(await failure(call("profiles.remove", { name: "desk" }, { profile: "desk" }))).toMatchObject({ reason: "Current" });
    expect(await failure(call("profiles.remove", { name: "nobody" }))).toMatchObject({ reason: "NotFound" });
    expect(await failure(call("profiles.remove", { name: "../up" }))).toMatchObject({ reason: "Name" });
    expect(await fs.readdir(root)).toContain("profiles");
  });
});
