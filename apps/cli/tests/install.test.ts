import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { hostTarget, packageName } from "../../../scripts/dist-config.ts";

/*
 * scripts/install.sh, which `lemma update` runs too, against a release of its own: an archive whose `lemma` only says
 * its version, served with its checksum, and an API that says each channel's newest (dist-check.ts installs a real one).
 */

const installer = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const VERSION = "0.2.7";
const name = packageName(VERSION, hostTarget());

let dir: string;
let bin: string;
let data: string;
/** What the API answers for stable's newest, and for every release. */
let latest = { status: 200, body: JSON.stringify({ tag_name: `v${VERSION}` }) };
let all = { status: 200, body: JSON.stringify([{ tag_name: `v${VERSION}` }]) };
let archive: Buffer;
const server = createServer((request, response) => {
  if (request.url === "/api/releases/latest") return void response.writeHead(latest.status).end(latest.body);
  if (request.url === "/api/releases?per_page=1") return void response.writeHead(all.status).end(all.body);
  if (request.url === `/${name}.tar.gz`) return void response.end(archive);
  if (request.url === `/${name}.tar.gz.sha256`) return void response.end(`${createHash("sha256").update(archive).digest("hex")}  ${name}.tar.gz\n`);
  response.writeHead(404).end();
});

const run = (command: string, args: readonly string[], env: Record<string, string | undefined> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LEMMA_CHANNEL: undefined, LEMMA_VERSION: undefined, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
  });

const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const install = (env: Record<string, string | undefined> = {}) =>
  run("sh", [installer], {
    HOME: dir,
    LEMMA_INSTALL_DIR: bin,
    LEMMA_DATA_DIR: data,
    LEMMA_RELEASE_BASE_URL: url(),
    LEMMA_RELEASE_API_URL: `${url()}/api`,
    ...env,
  });
/** What the installer recorded with the release `lemma` links to. */
const recorded = async () =>
  JSON.parse(await readFile(join(dirname(dirname(await realpath(join(bin, "lemma")))), "install.json"), "utf8")) as Record<string, unknown>;
const releases = async () => (await readdir(join(data, "releases"))).length;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lemma-install-"));
  const build = join(dir, "build", name);
  await mkdir(join(build, "bin"), { recursive: true });
  await mkdir(join(build, "runtime", "bin"), { recursive: true });
  await writeFile(join(build, "bin", "lemma"), `#!/bin/sh\necho ${VERSION}\n`);
  await writeFile(join(build, "runtime", "bin", "node"), "#!/bin/sh\n");
  await chmod(join(build, "bin", "lemma"), 0o755);
  await chmod(join(build, "runtime", "bin", "node"), 0o755);
  expect((await run("tar", ["-czf", join(dir, "archive.tar.gz"), "-C", join(dir, "build"), name])).code).toBe(0);
  archive = await readFile(join(dir, "archive.tar.gz"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  bin = await mkdtemp(join(dir, "bin-"));
  data = await mkdtemp(join(dir, "data-"));
  latest = { status: 200, body: JSON.stringify({ tag_name: `v${VERSION}` }) };
  all = { status: 200, body: JSON.stringify([{ tag_name: `v${VERSION}` }]) };
});

describe("the installer", () => {
  test("records the channel it installed from, and none for a version given alone, which is pinned", async () => {
    expect((await install()).code).toBe(0);
    expect((await recorded()).channel).toBe("stable");
    expect((await install({ LEMMA_CHANNEL: "nightly" })).code).toBe(0);
    expect((await recorded()).channel).toBe("nightly");
    expect((await install({ LEMMA_VERSION: VERSION })).code).toBe(0);
    expect(await recorded()).toEqual({ link: join(bin, "lemma"), dataDir: data });
    // As lemma update runs it: a version, and the channel to go on following.
    expect((await install({ LEMMA_VERSION: VERSION, LEMMA_CHANNEL: "stable" })).code).toBe(0);
    expect((await recorded()).channel).toBe("stable");
  });

  test("tells a channel with no release from a failure to ask which is newest", async () => {
    latest = { status: 404, body: JSON.stringify({ message: "Not Found" }) };
    expect((await install()).err).toContain("no stable release is published yet");
    latest = { status: 403, body: JSON.stringify({ message: "API rate limit exceeded for 127.0.0.1." }) };
    const limited = await install();
    expect(limited.code).toBe(1);
    expect(limited.err).toContain(`${url()}/api/releases/latest answered 403: API rate limit exceeded for 127.0.0.1.`);
    all = { status: 200, body: "[]" };
    expect((await install({ LEMMA_CHANNEL: "nightly" })).err).toContain("no release is published yet");
    all = { status: 502, body: "Bad Gateway" };
    expect((await install({ LEMMA_CHANNEL: "nightly" })).err).toContain("answered 502");
  });

  test("installs one at a time: another install's lock refuses it, one that stopped is taken back, and one done leaves no lock", async () => {
    await mkdir(join(data, "install.lock"));
    await writeFile(join(data, "install.lock", "pid"), `${process.pid}\n`);
    const refused = await install();
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`another install (pid ${process.pid}) is under way`);
    expect(await releases()).toBe(0);
    // One just taken, its pid not yet written, is under way too.
    await rm(join(data, "install.lock", "pid"));
    expect((await install()).err).toContain("another install is under way");
    // One that stopped, its process gone, left it: taken back.
    const gone = spawn("true");
    await new Promise((done) => gone.once("exit", done));
    await writeFile(join(data, "install.lock", "pid"), `${gone.pid}\n`);
    const taken = await install();
    expect(taken.code).toBe(0);
    expect(taken.err).toContain(`took back the lock an install that stopped (pid ${gone.pid}) left`);
    expect(await readdir(data)).toEqual(["releases"]);
  });

  test("keeps every release when ps cannot say which one a running host uses, and says to restart it", async () => {
    const noPs = join(dir, "no-ps");
    await mkdir(noPs, { recursive: true });
    await writeFile(join(noPs, "ps"), "#!/bin/sh\nexit 1\n");
    await chmod(join(noPs, "ps"), 0o755);
    const PATH = `${noPs}:${process.env.PATH}`;
    for (let i = 0; i < 3; i++) expect((await install({ PATH })).code).toBe(0);
    expect(await releases()).toBe(3);
    const again = await install({ PATH });
    expect(again.err).toContain("kept the releases before this one, as ps could not say which a running host uses");
    expect(again.out).toContain("Restart a running host to use this version: lemma restart");
    expect(await releases()).toBe(4);
    // With ps, only the one before stays.
    expect((await install()).code).toBe(0);
    expect(await releases()).toBe(2);
  });
});
