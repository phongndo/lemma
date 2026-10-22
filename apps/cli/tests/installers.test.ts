import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Io } from "../src/command.ts";
import { updateRelease } from "../src/commands/release.ts";
import { readBuild } from "../src/release.ts";

/*
 * How `lemma update` updates each way Lemma is installed (src/installers.ts), against releases of its own: a release is
 * a directory with its `release.json`, and the installer, Homebrew, mise, and npm are scripts that say what they were
 * asked and install as each would. GitHub's API says stable's newest is 0.2.8.
 */

let dir: string;
let calls: string;
const server = createServer((request, response) => {
  if (request.url === "/releases/latest") return void response.end(JSON.stringify({ tag_name: "v0.2.8" }));
  if (request.url === "/releases?per_page=1") return void response.end(JSON.stringify([{ tag_name: "v0.2.9" }]));
  response.writeHead(404).end();
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lemma-installers-"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});
let each = 0;
let at: string;
beforeEach(async () => {
  at = join(dir, String(++each));
  calls = join(at, "calls.log");
  await mkdir(join(at, "bin"), { recursive: true });
  await writeFile(calls, "");
});

/** A release at `root`: its `release.json`, and what installed it (`install.json`), if anything recorded that. */
const release = async (root: string, version: string, install?: Record<string, unknown>) => {
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "release.json"), JSON.stringify({ version }));
  await writeFile(join(root, "bin", "lemma"), "#!/bin/sh\n");
  await chmod(join(root, "bin", "lemma"), 0o755);
  if (install !== undefined) await writeFile(join(root, "install.json"), JSON.stringify(install));
};

/** The same in shell, for a fake package manager to install one with. */
const releaseSh = (root: string, version: string, install?: Record<string, unknown>) =>
  [
    `mkdir -p '${root}/bin'`,
    `printf '%s' '${JSON.stringify({ version })}' > '${root}/release.json'`,
    `printf '#!/bin/sh\\n' > '${root}/bin/lemma' && chmod +x '${root}/bin/lemma'`,
    ...(install === undefined ? [] : [`printf '%s' '${JSON.stringify(install)}' > '${root}/install.json'`]),
  ].join("\n");

/** A command at `path` that writes what it was asked to `calls`, then runs `body`. */
const fake = async (path: string, body: string) => {
  await writeFile(path, `#!/bin/sh\necho "$(basename "$0") $* cleanup=\${HOMEBREW_NO_INSTALL_CLEANUP:-}" >> '${calls}'\n${body}\n`);
  await chmod(path, 0o755);
};
const asked = async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean);

const env = (more: Record<string, string> = {}) => ({
  // The fakes first; the real commands they run (mkdir, ln) after them.
  PATH: `${join(at, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: at,
  LEMMA_HOME: join(at, "home"),
  LEMMA_RELEASE_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  ...more,
});
const ioWith = (vars: Record<string, string>): Io => ({ env: vars, cwd: at, out: () => {}, err: () => {} });

/** `lemma update` for the release at `root`, as `readBuild` reads it with `vars`. */
const update = (root: string, vars: Record<string, string>, version?: string, flags: { channel?: "stable" | "nightly"; check?: boolean } = {}) =>
  Effect.runPromise(updateRelease(ioWith(vars), readBuild(root, vars), version, flags));
const refused = (root: string, vars: Record<string, string>, version?: string, flags: { channel?: "stable" | "nightly"; check?: boolean } = {}) =>
  Effect.runPromise(Effect.flip(updateRelease(ioWith(vars), readBuild(root, vars), version, flags)));

describe("who installed a release", () => {
  test("says so from what it recorded, or where it lies, and how each updates", async () => {
    const vars = env({ HOMEBREW_PREFIX: join(at, "brew") });
    const read = async (root: string, install?: Record<string, unknown>) => {
      await release(root, "0.2.7", install);
      return readBuild(root, vars);
    };
    expect(await read(join(at, "script"), { channel: "nightly", link: "/l/lemma", dataDir: "/d" })).toMatchObject({
      installer: "script",
      update: "lemma update",
      channel: "nightly",
      link: "/l/lemma",
    });
    expect(await read(join(at, "formula"), { installer: "homebrew", link: "/opt/homebrew/bin/lemma" })).toMatchObject({
      installer: "homebrew",
      update: "brew upgrade phongndo/tap/lemma",
      channel: "stable",
      link: "/opt/homebrew/bin/lemma",
    });
    expect(await read(join(at, "npm"), { installer: "npm", link: "/n/lemma" })).toMatchObject({
      installer: "npm",
      update: "npm install --global lemma-harness",
    });
    expect(await read(join(at, "nix"), { installer: "nix" })).toMatchObject({ installer: "nix", update: expect.stringContaining("nix flake update lemma") });
    // The desktop app's resources: Homebrew's cask when its Caskroom has Lemma, else a download.
    const app = join(at, "Applications/Lemma.app/Contents/Resources/lemma");
    expect(await read(app)).toMatchObject({ installer: "desktop", update: expect.stringContaining("disk image"), link: join(app, "bin", "lemma") });
    await mkdir(join(at, "brew", "Caskroom", "lemma"), { recursive: true });
    expect(readBuild(app, vars)).toMatchObject({ installer: "homebrew-cask", update: "brew upgrade --cask phongndo/tap/lemma" });
    expect(await read(join(at, "opt/Lemma/resources/lemma"))).toMatchObject({ installer: "desktop", update: expect.stringContaining("AppImage") });
    // mise's installs, with `latest` the newest it installed: what a service and a restart run.
    const mise = join(at, "mise/installs/github-phongndo-lemma");
    expect(await read(join(mise, "0.2.7"))).toMatchObject({ installer: "mise", update: "mise upgrade github:phongndo/lemma", channel: "stable" });
    await symlink("0.2.7", join(mise, "latest"));
    expect(readBuild(join(mise, "0.2.7"), vars).link).toBe(join(mise, "latest", "bin", "lemma"));
    // Unpacked by hand: nothing says who, so nothing updates it.
    const unknown = await read(join(at, "unpacked"));
    expect(unknown.installer).toBeUndefined();
    expect(await refused(join(at, "unpacked"), vars)).toMatchObject({ code: "NotInstalled", message: expect.stringContaining("install.sh | sh") });
  });
});

describe("lemma update", () => {
  test("the installer's runs the installer the release carries, for its channel, into its directories", async () => {
    const root = join(at, "data/releases/lemma-v0.2.7");
    const link = join(at, "local/bin/lemma");
    await release(root, "0.2.7", { channel: "stable", link, dataDir: join(at, "data") });
    await mkdir(join(root, "scripts"));
    await mkdir(join(at, "local/bin"), { recursive: true });
    await symlink(join(root, "bin", "lemma"), link);
    const next = join(at, "data/releases/lemma-v0.2.8");
    await fake(
      join(root, "scripts", "install.sh"),
      `echo "$LEMMA_CHANNEL $LEMMA_VERSION $LEMMA_INSTALL_DIR $LEMMA_DATA_DIR" >> '${calls}'\n${releaseSh(next, "0.2.8", { channel: "stable", link, dataDir: join(at, "data") })}\nln -sfn '${next}/bin/lemma' '${link}'`,
    );
    const result = await update(root, env());
    expect(result.json).toMatchObject({ updated: true, from: "0.2.7", version: "0.2.8", installer: "script", channel: "stable", command: link, root: next });
    expect(await asked()).toContain(`stable 0.2.8 ${join(at, "local/bin")} ${join(at, "data")}`);
  });

  test("Homebrew's formula: brew update, then brew upgrade without its cleanup, so a running host keeps its release until it restarts", async () => {
    const prefix = join(at, "brew");
    const keg = (version: string) => join(prefix, "Cellar/lemma", version, "libexec");
    const install = { installer: "homebrew", link: join(prefix, "bin/lemma"), manager: join(prefix, "bin/brew") };
    await release(keg("0.2.7"), "0.2.7", install);
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink(join(keg("0.2.7"), "bin", "lemma"), join(prefix, "bin/lemma"));
    const lagging = join(at, "lagging");
    await fake(
      join(prefix, "bin/brew"),
      `[ "$1" = upgrade ] || exit 0\n[ -e '${lagging}' ] && exit 0\n${releaseSh(keg("0.2.8"), "0.2.8", install)}\nln -sfn '${keg("0.2.8")}/bin/lemma' '${prefix}/bin/lemma'`,
    );
    const vars = env({ HOMEBREW_PREFIX: prefix });
    // The tap's newest only, on stable.
    expect(await refused(keg("0.2.7"), vars, "0.2.5")).toMatchObject({ code: "Unsupported", message: expect.stringContaining("LEMMA_VERSION=0.2.5") });
    expect(await refused(keg("0.2.7"), vars, undefined, { channel: "nightly" })).toMatchObject({
      code: "Unsupported",
      message: expect.stringContaining("LEMMA_CHANNEL=nightly sh"),
    });
    // A tap that has not taken up the release yet installs nothing new, and says so.
    await writeFile(lagging, "");
    expect(await refused(keg("0.2.7"), vars)).toMatchObject({ code: "NotUpdated", message: expect.stringContaining("within an hour") });
    await rm(lagging);
    await writeFile(calls, "");
    const result = await update(keg("0.2.7"), vars);
    expect(result.json).toMatchObject({
      updated: true,
      from: "0.2.7",
      version: "0.2.8",
      installer: "homebrew",
      command: join(prefix, "bin/lemma"),
      root: keg("0.2.8"),
    });
    expect(await asked()).toEqual(["brew update --quiet cleanup=1", "brew upgrade --formula phongndo/tap/lemma cleanup=1"]);
    expect(await update(keg("0.2.8"), vars)).toMatchObject({ json: { updated: false, version: "0.2.8" } });
  });

  test("Homebrew's cask replaces the desktop app, which runs the release once reopened", async () => {
    const prefix = join(at, "brew");
    const app = join(at, "Applications/Lemma.app/Contents/Resources/lemma");
    await release(app, "0.2.7");
    await mkdir(join(prefix, "Caskroom/lemma"), { recursive: true });
    await mkdir(join(prefix, "bin"), { recursive: true });
    await fake(join(prefix, "bin/brew"), `[ "$1" = upgrade ] || exit 0\nprintf '%s' '{"version":"0.2.8"}' > '${app}/release.json'`);
    const result = await update(app, env({ HOMEBREW_PREFIX: prefix }));
    expect(result.json).toMatchObject({ updated: true, version: "0.2.8", installer: "homebrew-cask", reopen: true, command: join(app, "bin", "lemma") });
    expect(await asked()).toEqual(["brew update --quiet cleanup=1", "brew upgrade --cask phongndo/tap/lemma cleanup=1"]);
    expect(result.text).toContain("reopen");
  });

  test("mise: upgrades as its config allows, or makes a version given the global one", async () => {
    const installs = join(at, "mise/installs/github-phongndo-lemma");
    await release(join(installs, "0.2.7"), "0.2.7");
    await symlink("0.2.7", join(installs, "latest"));
    const pinned = join(at, "pinned");
    // What its config runs is `current`: `where` says where that is.
    const current = join(at, "current");
    await writeFile(current, join(installs, "0.2.7"));
    await fake(
      join(at, "bin/mise"),
      [
        `[ "$1" = where ] && exec cat '${current}'`,
        `[ -e '${pinned}' ] && exit 0`,
        `case "$1" in`,
        `  upgrade) ${releaseSh(join(installs, "0.2.8"), "0.2.8").replaceAll("\n", "; ")}; ln -sfn 0.2.8 '${installs}/latest'; printf '%s' '${join(installs, "0.2.8")}' > '${current}' ;;`,
        `  use) ${releaseSh(join(installs, "0.2.5"), "0.2.5").replaceAll("\n", "; ")}; printf '%s' '${join(installs, "0.2.5")}' > '${current}' ;;`,
        `esac`,
      ].join("\n"),
    );
    const result = await update(join(installs, "0.2.7"), env());
    expect(result.json).toMatchObject({ updated: true, version: "0.2.8", installer: "mise", command: join(installs, "latest", "bin", "lemma") });
    expect(await update(join(installs, "0.2.8"), env(), "0.2.5")).toMatchObject({ json: { updated: true, version: "0.2.5" } });
    expect((await asked()).filter((call) => !call.startsWith("mise where"))).toEqual([
      "mise upgrade github:phongndo/lemma cleanup=",
      "mise use --global github:phongndo/lemma@0.2.5 cleanup=",
    ]);
    // A config that asks for this version keeps it, though mise has a newer one.
    await writeFile(pinned, "");
    expect(await refused(join(installs, "0.2.5"), env())).toMatchObject({
      code: "NotUpdated",
      message: expect.stringContaining("mise use --global github:phongndo/lemma@latest"),
    });
  });

  test("npm: npm install --global the release, whose launcher then fetches it", async () => {
    const data = join(at, "npm-data");
    const launcher = join(at, "npm/bin/lemma");
    const install = { installer: "npm", link: launcher, manager: join(at, "npm/bin/npm") };
    await release(join(data, "lemma-v0.2.7"), "0.2.7", install);
    await mkdir(join(at, "npm/bin"), { recursive: true });
    await writeFile(launcher, "#!/bin/sh\nexit 1\n");
    await chmod(launcher, 0o755);
    // Installing a version puts its launcher in place, which fetches the release the first time it runs.
    const next = join(data, "lemma-v0.2.8");
    await fake(
      join(at, "npm/bin/npm"),
      `cat > '${launcher}' <<'EOF'\n#!/bin/sh\n${releaseSh(next, "0.2.8", install)}\nprintf '{"version":"0.2.8","root":"${next}"}\\n'\nEOF\nchmod +x '${launcher}'`,
    );
    const result = await update(join(data, "lemma-v0.2.7"), env(), "0.2.8");
    expect(result.json).toMatchObject({ updated: true, version: "0.2.8", installer: "npm", command: launcher, root: next });
    expect(await asked()).toEqual(["npm install --global lemma-harness@0.2.8 cleanup="]);
  });

  test("Nix's, and the desktop app from its file: whether a newer release is out, and how to update, and nothing replaced", async () => {
    const nix = join(at, "nix");
    await release(nix, "0.2.7", { installer: "nix" });
    expect(await update(nix, env(), undefined, { check: true })).toMatchObject({
      json: { newer: true, newest: "0.2.8", channel: "stable" },
      text: expect.stringContaining("nix flake update lemma"),
    });
    expect(await refused(nix, env())).toMatchObject({ code: "NotInstalled", message: expect.stringContaining("installed with Nix") });
    const app = join(at, "opt/Lemma/resources/lemma");
    await release(app, "0.2.7");
    expect(await refused(app, env())).toMatchObject({ code: "NotInstalled", message: expect.stringContaining("AppImage or Debian package") });
  });
});
