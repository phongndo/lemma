import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { startLemma } from "../../../scripts/e2e.ts";
import type { Lemma } from "../../../scripts/e2e.ts";
import { ExitCode, run } from "../src/cli.ts";
import { invoke, printOnFailure } from "./invoke.ts";

describe("profiles: separate Lemmas on this machine", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lemma-cli-profiles-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("profile lists the default, Core, alone until another is made; create makes one with a port of its own; remove asks first", async () => {
    expect(JSON.parse((await invoke(["profile", "--json"], root)).out)).toEqual({
      profiles: [{ name: "default", title: "Core", home: root, port: null, url: null, running: false, using: true }],
      using: "default",
    });
    const made = JSON.parse((await invoke(["profile", "create", "desk", "--json"], root)).out);
    expect(made).toMatchObject({ name: "desk", home: join(root, "profiles", "desk") });
    expect(made.port).toBeGreaterThanOrEqual(7434);
    expect(JSON.parse(await readFile(join(root, "profiles", "desk", "profile.json"), "utf8"))).toEqual({ port: made.port });
    expect((await invoke(["profile", "-q"], root)).out.split("\n")).toEqual(["default", "desk"]);
    // The one a command uses is the one --profile or LEMMA_PROFILE names.
    expect(JSON.parse((await invoke(["profile", "--profile", "desk", "--json"], root)).out).using).toBe("desk");
    expect(JSON.parse((await invoke(["profile", "--json"], root, "/", { LEMMA_PROFILE: "desk" })).out).using).toBe("desk");

    expect(JSON.parse((await invoke(["profile", "create", "desk", "--json"], root)).err).error.code).toBe("Exists");
    for (const argv of [
      ["profile", "create", "Desk"],
      ["profile", "create", "default"],
      ["profile", "remove", "default"],
      ["status", "--profile", "../up"],
    ])
      expect((await invoke(argv, root)).code, argv.join(" ")).toBe(ExitCode.usage);
    expect((await invoke(["status"], root, "/", { LEMMA_PROFILE: "No Name" })).code).toBe(ExitCode.usage);

    // No terminal to ask at: nothing is deleted without --force.
    expect(JSON.parse((await invoke(["profile", "remove", "desk", "--json"], root)).err).error.code).toBe("NotConfirmed");
    expect(existsSync(join(root, "profiles", "desk"))).toBe(true);
    expect(JSON.parse((await invoke(["profile", "remove", "desk", "--force", "--json"], root)).out)).toMatchObject({ removed: true, name: "desk" });
    expect(existsSync(join(root, "profiles", "desk"))).toBe(false);
  });

  test("serve runs the host for the profile named, refusing one never made; completing words needs no profile", async () => {
    await invoke(["profile", "create", "desk"], root);
    const served: (string | undefined)[] = [];
    const io = {
      env: { LEMMA_HOME: root },
      cwd: "/",
      out: () => {},
      err: () => {},
      serve: async (_argv: readonly string[], profile: string | undefined) => void served.push(profile),
    };
    expect(await run(["serve", "--profile", "desk"], io)).toBe(ExitCode.ok);
    expect(await run(["serve"], io)).toBe(ExitCode.ok);
    expect(served).toEqual(["desk", undefined]);
    const typo = await invoke(["serve", "--profile", "dsek", "--json"], root);
    expect(JSON.parse(typo.err).error).toMatchObject({ code: "NoProfile", message: expect.stringContaining("lemma profile create dsek") });
    expect(existsSync(join(root, "profiles", "dsek"))).toBe(false);
    const completed = await invoke(["__complete", "prof"], root, "/", { LEMMA_PROFILE: "Not A Name" });
    expect(completed).toMatchObject({ code: ExitCode.ok, out: "profile" });
  });

  test("--profile points a command at the profile's home: its config, and its host, which says how to start it", async () => {
    await invoke(["profile", "create", "desk"], root);
    expect(JSON.parse((await invoke(["config", "path", "--profile", "desk", "--json"], root)).out)).toMatchObject({
      home: join(root, "profiles", "desk"),
      user: join(root, "profiles", "desk", "config.jsonc"),
    });
    const none = JSON.parse((await invoke(["status", "--profile", "desk", "--json"], root)).err).error;
    expect(none).toMatchObject({ code: "NoHost", message: expect.stringContaining("lemma --profile desk serve") });
  });
});

describe("profiles: one opened from another's host", () => {
  let lemma: Lemma;
  let desk: { readonly pid: number } | undefined;
  let other: string;
  beforeAll(async () => {
    lemma = await startLemma("lemma-cli-profiles-host-");
    other = await mkdtemp(join(tmpdir(), "lemma-cli-profiles-client-"));
  }, 30_000);
  afterAll(async () => {
    if (desk !== undefined) process.kill(desk.pid, "SIGTERM");
    await lemma?.stop();
    if (other !== undefined) await rm(other, { recursive: true, force: true });
  });
  printOnFailure(() => lemma?.output());

  test("profiles.open starts the profile's host, which --profile then reaches; on another machine only when named", async () => {
    expect((await invoke(["profile", "create", "desk"], lemma.home)).code).toBe(ExitCode.ok);
    // Any free port, so the test takes none a running Lemma has.
    const deskHome = join(lemma.home, "profiles", "desk");
    await mkdir(deskHome, { recursive: true });
    await writeFile(join(deskHome, "config.jsonc"), JSON.stringify({ plugins: { "transport.server": { config: { port: 0 } } } }));

    const opened = await invoke(["channels", "call", "profiles.open", JSON.stringify({ name: "desk" }), "--json"], lemma.home);
    expect(opened.code, opened.err).toBe(ExitCode.ok);
    const answer = JSON.parse(opened.out) as { url: string; port: number; token: string };
    desk = JSON.parse(await readFile(join(deskHome, "transport.json"), "utf8"));
    expect(answer.url).toBe(`http://127.0.0.1:${answer.port}`);

    const status = JSON.parse((await invoke(["status", "--profile", "desk", "--json"], lemma.home)).out);
    expect(status).toMatchObject({ url: answer.url, info: { home: deskHome, profile: "desk" } });
    const listed = JSON.parse((await invoke(["channels", "call", "profiles.list", "--json"], lemma.home)).out) as { name: string; running: boolean }[];
    expect(listed.map(({ name, running }) => ({ name, running }))).toEqual([
      { name: "default", running: true },
      { name: "desk", running: true },
    ]);

    // A client whose environment is that host: a profile it inherits (LEMMA_PROFILE) is its own machine's, and goes
    // nowhere there; one it names (--profile) is opened there, but never through a loopback address, which may be a
    // tunnel to another machine.
    const { url, token } = JSON.parse(await readFile(join(lemma.home, "transport.json"), "utf8"));
    await writeFile(join(other, "environments.json"), JSON.stringify({ default: "box", environments: { box: { url, token } } }));
    expect(JSON.parse((await invoke(["status", "--json"], other, "/", { LEMMA_PROFILE: "desk" })).out)).toMatchObject({
      environment: "box",
      info: { home: lemma.home },
    });
    const tunnel = await invoke(["status", "--profile", "desk", "--json"], other);
    expect(JSON.parse(tunnel.err).error).toMatchObject({ code: "Unreachable", message: expect.stringContaining("loopback") });
  }, 60_000);
});
