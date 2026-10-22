import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hostTarget, packageName } from "../../../scripts/dist-config.ts";

/*
 * npm's `lemma-harness` (packaging/npm), installed as npm installs it, against releases of its own: archives whose
 * `lemma` says what it was asked and exits with the code `EXIT` names, served with their checksums.
 */

const launcherSource = fileURLToPath(new URL("../../../packaging/npm", import.meta.url));
let dir: string;
const archives = new Map<string, Buffer>();
let broken = false;
const server = createServer((request, response) => {
  const file = request.url?.split("/").at(-1) ?? "";
  const archive = archives.get(file.replace(/\.sha256$/, ""));
  if (archive === undefined) return void response.writeHead(404).end();
  if (!file.endsWith(".sha256")) return void response.end(archive);
  const sum = broken ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex");
  response.end(`${sum}  ${file.replace(/\.sha256$/, "")}\n`);
});

const run = (args: readonly string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, "prefix/lib/node_modules/lemma-harness/bin/lemma.js"), ...args], {
      env: { ...process.env, LEMMA_NPM_DIR: join(dir, "data"), LEMMA_RELEASE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
  });

/** A release of `version`, as its archive: a `lemma` that prints its version and arguments, and exits `$EXIT`. */
const publish = async (version: string) => {
  const name = packageName(version, hostTarget());
  const build = join(dir, "build", name);
  await mkdir(join(build, "bin"), { recursive: true });
  await mkdir(join(build, "runtime", "bin"), { recursive: true });
  await writeFile(join(build, "release.json"), JSON.stringify({ version }));
  await writeFile(join(build, "bin", "lemma"), `#!/bin/sh\necho "${version} $*"\nexit "\${EXIT:-0}"\n`);
  await writeFile(join(build, "runtime", "bin", "node"), "#!/bin/sh\n");
  await chmod(join(build, "bin", "lemma"), 0o755);
  await chmod(join(build, "runtime", "bin", "node"), 0o755);
  const tar = await new Promise<number | null>((done) =>
    spawn("tar", ["-czf", join(dir, `${name}.tar.gz`), "-C", join(dir, "build"), name]).once("close", done),
  );
  expect(tar).toBe(0);
  archives.set(`${name}.tar.gz`, await readFile(join(dir, `${name}.tar.gz`)));
};

/** Installs the package at `version`, as `npm install --global` puts it in place. */
const install = async (version: string) => {
  const at = join(dir, "prefix/lib/node_modules/lemma-harness");
  await rm(at, { recursive: true, force: true });
  await cp(launcherSource, at, { recursive: true });
  const manifest = JSON.parse(await readFile(join(at, "package.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(at, "package.json"), JSON.stringify({ ...manifest, version }));
};

beforeAll(async () => {
  // Resolved, as the paths lemma reports are: on macOS, tmpdir() is under /var, a link to /private/var.
  dir = await realpath(await mkdtemp(join(tmpdir(), "lemma-npm-")));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  for (const version of ["0.2.7", "0.2.8", "0.2.9"]) await publish(version);
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});

describe("lemma-harness", () => {
  test("fetches its version's release outside node_modules once, then runs it with what it was given, and its exit code", async () => {
    await install("0.2.7");
    const first = await run(["status", "--json"]);
    expect(first).toMatchObject({ code: 0, out: "0.2.7 status --json\n" });
    expect(first.err).toContain("fetching Lemma 0.2.7");
    const name = packageName("0.2.7", hostTarget());
    // What installed it, for `lemma update`: npm beside the Node.js that ran it, and `current`'s lemma.
    expect(JSON.parse(await readFile(join(dir, "data", name, "install.json"), "utf8"))).toMatchObject({
      installer: "npm",
      link: join(dir, "data", "current", "bin", "lemma"),
      install: ["install", "--global"],
      node: process.execPath,
      package: "lemma-harness",
    });
    expect(await readlink(join(dir, "data", "current"))).toBe(name);
    const again = await run(["doctor"], { EXIT: "3" });
    expect(again).toMatchObject({ code: 3, out: "0.2.7 doctor\n", err: "" });
  });

  test("a new version fetches its release and links it, keeping the one before and removing older ones", async () => {
    await install("0.2.8");
    expect((await run(["version"])).out).toBe("0.2.8 version\n");
    await install("0.2.9");
    expect((await run(["version"])).out).toBe("0.2.9 version\n");
    const kept = (await readdir(join(dir, "data"))).filter((entry) => entry.startsWith("lemma-v")).sort();
    expect(kept).toEqual([packageName("0.2.8", hostTarget()), packageName("0.2.9", hostTarget())]);
    expect(await readlink(join(dir, "data", "current"))).toBe(packageName("0.2.9", hostTarget()));
  });

  test("refuses a release that does not match its checksum, and runs nothing", async () => {
    await rm(join(dir, "data"), { recursive: true, force: true });
    broken = true;
    try {
      const result = await run(["version"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("does not match its checksum");
      expect(result.out).toBe("");
    } finally {
      broken = false;
    }
  });
});
