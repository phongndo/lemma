import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compareVersions } from "@lemma/release";
import packageJson from "../package.json" with { type: "json" };
import { ExitCode } from "../src/cli.ts";
import { newestRelease, readBuild } from "../src/release.ts";
import { invoke } from "./invoke.ts";

const checkout = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

describe("what this lemma is", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lemma-cli-release-"));
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  test("a checkout is its version, its root, and its commit", async () => {
    const result = await invoke(["version", "--json"], home);
    expect(result.code, result.err).toBe(ExitCode.ok);
    expect(JSON.parse(result.out)).toMatchObject({ version: packageJson.version, kind: "checkout", root: checkout, node: process.versions.node });
    expect((await invoke(["version", "--text"], home)).out).toMatch(new RegExp(`^Lemma ${packageJson.version.replaceAll(".", "\\.")}, a checkout\\ncheckout `));
  });

  test("a release says what built it, and the installer how it installed it", async () => {
    const root = join(home, "release");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "release.json"), JSON.stringify({ version: "0.2.7", commit: "a".repeat(40), built: "2026-10-21T05:41:00Z" }));
    expect(readBuild(root)).toEqual({
      version: "0.2.7",
      kind: "release",
      root,
      node: process.versions.node,
      commit: "a".repeat(40),
      built: "2026-10-21T05:41:00Z",
    });
    await writeFile(
      join(root, "install.json"),
      JSON.stringify({ channel: "nightly", link: "/home/me/.local/bin/lemma", dataDir: "/home/me/.local/share/lemma" }),
    );
    expect(readBuild(root)).toMatchObject({ channel: "nightly", link: "/home/me/.local/bin/lemma", dataDir: "/home/me/.local/share/lemma" });
    // A channel it does not know is none, as is a release installed by version, which is pinned.
    await writeFile(join(root, "install.json"), JSON.stringify({ channel: "beta", link: "/l", dataDir: "/d" }));
    expect(readBuild(root).channel).toBeUndefined();
    await writeFile(join(root, "install.json"), JSON.stringify({ link: "/l", dataDir: "/d" }));
    expect(readBuild(root)).toMatchObject({ link: "/l", dataDir: "/d" });
    expect(readBuild(root).channel).toBeUndefined();
  });

  test("a checkout updates with git, and has no host to restart", async () => {
    const update = await invoke(["update", "--json"], home);
    expect(update.code).toBe(ExitCode.failed);
    expect(JSON.parse(update.err).error).toMatchObject({ code: "Checkout", message: expect.stringContaining(checkout) });
    expect((await invoke(["update", "0.2", "--json"], home)).code).toBe(ExitCode.failed);
    expect(JSON.parse((await invoke(["restart", "--json"], home)).err).error.code).toBe("NoHost");
    expect((await invoke(["restart", "--env", "box"], home)).code).toBe(ExitCode.usage);
  });
});

describe("the newest release", () => {
  // GitHub's API, as the channels read it: the latest release, and the newest of all.
  let latest: { tag_name: string } | undefined = { tag_name: "v0.2.5" };
  const all = [{ tag_name: "v0.2.9" }, { tag_name: "v0.2.5" }];
  const server = createServer((request, response) => {
    if (request.url === "/releases/latest") return void (latest === undefined ? response.writeHead(404).end("{}") : response.end(JSON.stringify(latest)));
    if (request.url === "/releases?per_page=1") return void response.end(JSON.stringify(all.slice(0, 1)));
    response.writeHead(500).end();
  });
  let api: string;
  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  test("stable is the release marked latest, nightly the newest, and a channel with none is undefined", async () => {
    expect(await newestRelease(api, "stable")).toBe("0.2.5");
    expect(await newestRelease(api, "nightly")).toBe("0.2.9");
    latest = undefined;
    expect(await newestRelease(api, "stable")).toBeUndefined();
    await expect(newestRelease(`${api}/gone`, "nightly")).rejects.toThrow(/500/);
  });

  test("versions compare by number, not as text", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.9", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});
