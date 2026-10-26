import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SHUTDOWN_TIMEOUT_MS } from "../packages/host/src/limits.ts";
import { desktopPackageName, hostTarget, parseDesktopPackageName, version as checkoutVersion } from "./dist-config.ts";
import { startTrial } from "./dist-trial.ts";
import { settled } from "./e2e.ts";

/*
 * Opens a desktop app (`pnpm dist:desktop` builds it at the checkout's version; or pass its path) as a user would,
 * outside the checkout, with a `node` on PATH that fails (dist-trial.ts): the AppImage itself, the Debian package by
 * its desktop entry, unpacked or, with `--installed`, as apt installed it, or the app in its disk image. It starts a
 * host from the release it carries, on Electron, which does what every release's host does (dist-trial.ts); quitting
 * the app stops that host. Then the app's own `lemma` starts one, on the app's Electron as Node.js, which does the same
 * (not an AppImage's, whose files go once it quits). Linux needs a display (`xvfb-run`).
 *
 *   pnpm dist:desktop:check dist/lemma-desktop-v0.2.7-linux-x64.AppImage
 *   sudo apt install ./dist/lemma-desktop-v0.2.7-linux-x64.deb && pnpm dist:desktop:check --installed dist/lemma-desktop-v0.2.7-linux-x64.deb
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { installed: { type: "boolean", default: false } } });
const root = fileURLToPath(new URL("..", import.meta.url));
const artifact = resolve(
  positionals[0] ?? join(root, "dist", `${desktopPackageName(checkoutVersion, hostTarget())}.${process.platform === "darwin" ? "dmg" : "AppImage"}`),
);
const named = parseDesktopPackageName(basename(artifact));
assert.ok(named, `${basename(artifact)} is not named as a desktop app, lemma-desktop-v<version>-<target>.<dmg|AppImage|deb>`);
assert.equal(named.target, hostTarget(), `${basename(artifact)} is for another platform than this one`);
const { version, format } = named;
assert.ok(!values.installed || format === "deb", "--installed is for a Debian package apt installed");
/** How long quitting may take: the app lets its host take its time to stop, and waits a little past it. */
const QUIT_MS = SHUTDOWN_TIMEOUT_MS + 20_000;

const trial = await startTrial("dist-desktop-check");
// The project the host serves: an app opened from a launcher has none and takes the home directory.
trial.env.INIT_CWD = trial.project;
let mounted: string | undefined;
let host: number | undefined;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The executable that starts the app, as a user's launcher does. */
const open = async (): Promise<string> => {
  if (format === "AppImage") {
    // Executable, as a user makes it once downloaded: GitHub's artifacts keep no file modes either.
    await chmod(artifact, 0o755);
    return artifact;
  }
  if (format === "deb") {
    const prefix = values.installed ? "/" : join(trial.temporary, "deb");
    if (values.installed) {
      const installed = execFileSync("dpkg-query", ["--show", "--showformat=${Version}", "lemma-desktop"], { encoding: "utf8" });
      assert.equal(installed, version, "apt installed this package");
    } else {
      execFileSync("dpkg-deb", ["-x", artifact, prefix]);
    }
    const entry = await readFile(join(prefix, "usr/share/applications/lemma-desktop.desktop"), "utf8");
    assert.match(entry, /^MimeType=x-scheme-handler\/lemma;$/m, "the desktop entry opens lemma:// links");
    const exec = /^Exec=(\S+)/m.exec(entry)?.[1];
    assert.ok(exec, "the desktop entry starts the app");
    return join(prefix, exec);
  }
  mounted = await mkdtemp(join(tmpdir(), "lemma-dmg-"));
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mounted, artifact], { stdio: "ignore" });
  const app = join(mounted, "Lemma.app");
  // A seal that does not hold says "damaged" rather than offering to open the app anyway.
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  return join(app, "Contents/MacOS/Lemma");
};

try {
  const executable = await open();
  await trial.provide();
  // Electron's own files, its single-instance lock among them, apart from an installed Lemma's, which HOME does not
  // move them from where XDG_CONFIG_HOME is set.
  const app = trial.launch(executable, [`--user-data-dir=${join(trial.temporary, "user data")}`], { stopWithin: QUIT_MS });
  // The app says it runs once its window shows the host's page.
  const desktop = await settled(
    async () => JSON.parse(await readFile(join(trial.lemmaHome, "desktop.json"), "utf8")) as { pid: number; open: readonly string[] },
    undefined,
    90_000,
  );
  assert.equal(desktop?.pid, app.child.pid, `the app did not open its window:\n${app.output()}`);
  host = (JSON.parse(await readFile(join(trial.lemmaHome, "transport.json"), "utf8")) as { pid: number }).pid;
  assert.notEqual(host, app.child.pid, "the host runs in a process of its own");

  // The release among the resources of the app as it runs: an AppImage's, where it mounted itself.
  const running = desktop!.open[0]!;
  const resources = process.platform === "darwin" ? join(dirname(dirname(running)), "Resources") : join(dirname(running), "resources");
  const lemma = join(resources, "lemma/bin/lemma");
  assert.equal((await trial.command(lemma, ["--version"])).trim(), version, "the app carries the release of its version");
  await trial.checkHost(lemma, version);

  // Quitting stops the host the app started, with nothing in progress to ask about, as a dialog asking would wait.
  app.child.kill("SIGTERM");
  const quit = await settled(async () => (app.child.exitCode !== null || app.child.signalCode !== null ? true : undefined), undefined, QUIT_MS);
  assert.ok(quit, `the app did not quit within ${QUIT_MS / 1000} s:\n${app.output()}`);
  assert.ok(await settled(async () => (alive(host!) ? undefined : true), undefined, 30_000), "quitting the app stops its host");
  assert.ok(!existsSync(join(trial.lemmaHome, "desktop.json")), "a quit app no longer says it runs");

  // A host the app's `lemma` starts itself, as the cask's does in a terminal: on the app's Electron run as Node.js, in
  // the foreground and again in the background (`lemma restart`). Not the AppImage's, whose files went with it.
  const own = existsSync(lemma);
  if (own) {
    trial.launch(lemma, ["serve", "--no-open"]);
    await settled(() => trial.command(lemma, ["status"]), undefined, 60_000);
    host = (JSON.parse(await trial.command(lemma, ["restart", "--json"])) as { pid: number }).pid;
    await trial.checkHost(lemma, version);
    await trial.command(lemma, ["stop"]);
  }
  console.log(
    `desktop (${format}${values.installed ? ", installed" : ""}): the window, its host, plugins, web app, file search, the agent's CLI, a turn, and quitting${own ? ", and the host its lemma starts," : ""} passed`,
  );
} finally {
  await trial.stop();
  // A host its app did not stop, as one killed partway through quitting leaves.
  if (host !== undefined && alive(host)) process.kill(host, "SIGKILL");
  if (mounted !== undefined) {
    try {
      execFileSync("hdiutil", ["detach", mounted, "-force"], { stdio: "ignore" });
      await rmdir(mounted);
    } catch (error) {
      console.error(error);
    }
  }
  await trial.close();
}
